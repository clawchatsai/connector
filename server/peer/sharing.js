// SharingManager: this connector's side of gateway sharing (clawchats specs/gateway-sharing.md).
//
// Owner side (someone uses this gateway's agents):
//   - approve(): build the grant (which agents, access, daily cap, the requester gateway's key),
//     sign it with this connector's key, keep it locally and send it to the signal server.
//   - inbound peer links are served only for a local, unrevoked grant, to the requester key pinned
//     in it (PeerLink verifies). The peer API is narrow: agents / turn / abort.
//   - each guest turn runs in a normal session on this gateway, one per (share, room, agent), in
//     the "Shared with <name>" group: read-only (or guarded) permission mode, no web search,
//     a finite timeout, never interpreted as a slash command, and a daily turn cap.
// Requester side (this gateway uses someone else's agents):
//   - grants pushed by the signal server are trusted only when signed by the owner gateway key
//     pinned for that share (first sight; a changed key is refused until the share is renewed).
//   - turns go over a PeerLink opened through the signal server (openPeer) on demand.

import crypto from 'node:crypto';
import { PeerLink } from './link.js';
import { canonicalJson, verifySignature, fingerprint } from './keys.js';
import { redactSecrets } from '../util/redact.js';
import { createChatAbort } from '../util/chat-abort.js';
import { ensureGuestRestrictions, findGuestAgent, isGuestAgent } from './guest-agent.js';
import { ContactBook, personKeyOf } from './contacts.js';
import { AUTONOMY, ACCESS, sessionMode, toolOverrides as contactOverrides, topicsNote, copyTools, copyToolsHold, copyKind, defaultContact, TOOL_GROUPS, ALWAYS_OFF, BASIC_DEFAULTS, DEFAULT_TOOLS, DEFAULT_COMMANDS } from './contact-policy.js';
import { ensureContactCopy, retireCopy, reviewerModelFor } from './contact-copy.js';
import { noteCandidates, resolvePicks, picksSignature, syncNotes, removeNotes, NOTES_DIR } from './notes-sync.js';
import { peerOutdated, outdatedMessage, connectorVersion } from './version.js';
import { promptIndex, replyAfter } from '../util/turn-reply.js';

const TURN_TIMEOUT_MS = 10 * 60_000;
// A turn whose commands may ask the owner: as long as the gateway keeps an approval pending (30 min) plus the run.
const APPROVAL_TURN_TIMEOUT_MS = 35 * 60_000;
/** The gateway's "the run gave no visible reply" failure (2026.10.1+: a passed turn, see team.js PASS_TOKEN). */
export const EMPTY_REPLY_ERROR = /empty response|did not produce a visible reply/i;
const MAX_CONCURRENT_TURNS = 2;   // per share: the daily cap alone would allow 50 parallel 10-minute runs
// Owner side: finished guest turns, so a resend after a dropped link gets the result instead of a new run.
const RECENT_TURN_MS = 10 * 60_000;
const RECENT_TURNS_MAX = 200;
// Requester side: waits before sending a turn again after its link dropped (one resend per entry). The last one covers
// an owner whose connector reload took ~8 s to stop (2026.11.6, its gateway busy preparing the guest run).
const RESEND_BACKOFF_MS = [2_000, 5_000, 10_000];
// Owner side: a turn its gateway's restart cut off. 2026.11.x resumes it a few seconds after it's back (a "Gateway
// restarted" turn of its own, under another run id); this long for that to start, polled this often.
const RECOVERY_WAIT_MS = 30_000;
const RECOVERY_POLL_MS = 2_000;
/** Old grants (v1) carried a daily cap; migrated contacts get the autonomy tier closest to it. */
const autonomyFromCap = cap => (Number(cap) > 50 ? 'extended' : 'bounded');
/**
 * Requests one contact's gateway may make of this one over the sharing link: [burst, per ms] token
 * buckets per contact and kind. Far above what a person and their agents send in a chat (a turn per
 * agent per round, a post per message, batched room pushes); they stop a peer that floods.
 */
const PEER_RATES = { turn: [20, 60_000], 'room.post': [30, 60_000], 'room.sync': [300, 60_000], '*': [120, 60_000] };
/**
 * The gateway loads any local image path or file:// URL written in a prompt (detectImageReferences),
 * ignoring the agent's tool policy and fs.workspaceOnly, so a guest could type the path of one of the
 * owner's screenshots and have the agent describe it. A zero-width space before each path with a file
 * extension (and inside `file://`) stops that match; the agent still reads the text normally, and
 * other text (`/commands`, `~`) passes through unchanged.
 * The gateway blanks attachment markers ("[media attached: \u2026]", "[Image: source: \u2026]") before it looks
 * for paths, so a path right after one starts a fresh word there: markers are broken too (and `]`
 * counts as a word start), and "MEDIA:" lines never pass as the gateway's attachment syntax.
 */
export const defangLocalPaths = text => String(text ?? '')
  .replace(/\[(?=\s*(?:media\s+attached|image\s*:))/gi, '[\u200b')
  .replace(/file:\/\//gi, 'file:\u200b//')
  .replace(/\bMEDIA:/gi, m => `${m.slice(0, -1)}\u200b:`)
  .replace(/(^|[\s"'`(\]])(?=(?:\.\.?[\\/]|[~/\\]|[A-Za-z]:[\\/])[^\s"'`()[\]]*\.[A-Za-z0-9])/g, '$1\u200b');
const GUEST_NOTE = name => `(Shared session: you are answering ${name}'s team chat on behalf of your owner. ${name} is not your owner — don't reveal your owner's private information or act on your owner's accounts for them.)`;
const files0 = notes => (notes ? [...notes.candidates.filter(x => x.on).map(x => x.path), ...notes.repoDocs.map(x => x.path)] : null);
// A copy with picked notes (Knowledge "My notes"): where they are.
const NOTES_NOTE = name => `(Your owner chose to share the notes in the ${NOTES_DIR}/ folder of your workspace with ${name}: read them and use them freely to answer. Anything that isn't in them stays private.)`;
// The same agent in its owner's own team chat, answering another person's agent (localTurnFor).
const ACTING_FOR_NOTE = (name, byPerson) => `(Shared session: in your owner's team chat, you are answering ${byPerson ? name : `${name}'s agent`}, so you act for ${name}, not for your owner. ${name} is not your owner — don't reveal your owner's private information or act on your owner's accounts for them.)`;

/** A guest turn's emit with secrets redacted from streamed text (see _guestTurn). */
const redacting = emit => emit && ((event, data) => emit(event, event === 'delta' ? redactSecrets(data) : data));
/** A name that came from the other side, safe to show and to use as a chat label (no brackets, newlines, controls). */
const cleanName = (v, max = 40) => String(v || '').replace(/[\u0000-\u001f\u007f-\u009f\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const firstName = p => cleanName(String(p?.name || p?.email || 'Someone').split(/[\s@]/)[0], 30) || 'Someone';

function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  return '';
}

export class SharingManager {
  /**
   * @param {object} o
   * @param {() => any} o.getDb          global.db
   * @param {(m: string, p: object, t?: number) => Promise<any>} o.request  gateway RPC
   * @param {{ publicKey: string, signJson(o): string }} o.key  this connector's peer key
   * @param {() => string} o.gatewayId   this gateway's id on the signal server
   * @param {(msg: object) => void} o.signal  send a message to the signal server
   * @param {(shareId: string) => Promise<{ dc, dtls }>} o.openPeer  open a peer DataChannel (requester)
   * @param {(data: string) => void} o.broadcast  frame to this gateway's browsers
   */
  constructor({ getDb, request, chatAbort = null, key, gatewayId, signal, openPeer, broadcast = () => {}, log = console, resendBackoffMs = RESEND_BACKOFF_MS, recovery = { waitMs: RECOVERY_WAIT_MS, pollMs: RECOVERY_POLL_MS }, version = connectorVersion(), holdApprovals = null }) {
    Object.assign(this, { getDb, request, key, gatewayId, signal, openPeer, broadcast, log, resendBackoffMs, recovery, version, holdApprovals });
    this.chatAbort = chatAbort || createChatAbort((m, p, t) => this.request(m, p, t)); // Stop, fenced where supported
    this._shares = [];            // latest share-list from the signal server
    this.serverEnabled = false;   // the signal server sends a share-list only to accounts with sharing on
    this._links = new Map();      // shareId -> PeerLink (requester side, one per share)
    this._linking = new Map();    // shareId -> Promise<PeerLink>
    this._served = new Set();     // owner-side PeerLinks
    this._runs = new Map();       // runId -> { resolve, timer, text } (owner-side guest runs)
    // Owner-side guest turns, keyed by an id made here (never the requester's):
    // { shareId, clientTurnId, same, sessionKey, runId, sessionId, aborted, emit, result }
    this._turns = new Map();
    this._finished = new Map();   // `${shareId}|${clientTurnId}` -> { same, result | error, at } (RECENT_TURN_MS)
    this._buckets = new Map();    // `${gateway}|${kind}` -> { tokens, at } (PEER_RATES)
    this.book = new ContactBook(getDb); // contact cards: per-person settings, copies, usage (owner side)
    this._peerVersions = new Map(); // their gateway id -> connector version from its last link hello (null: too old to say)
    this._copying = new Map();    // `${person}|${agent}` -> Promise (one copy write at a time)
    this._ready = false;
  }

  _db() {
    const g = this.getDb();
    if (!this._ready) {
      g.exec(`CREATE TABLE IF NOT EXISTS peer_grants (share_id TEXT PRIMARY KEY, grant_json TEXT NOT NULL, sig TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER)`);
      g.exec(`CREATE TABLE IF NOT EXISTS peer_funnel (email TEXT PRIMARY KEY, project TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
      g.exec(`CREATE TABLE IF NOT EXISTS peer_pins (share_id TEXT PRIMARY KEY, owner_pubkey TEXT NOT NULL, created_at INTEGER NOT NULL)`);
      g.exec(`CREATE TABLE IF NOT EXISTS peer_sessions (share_id TEXT NOT NULL, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_key TEXT NOT NULL, PRIMARY KEY (share_id, room_id, agent_id))`);
      g.exec(`CREATE TABLE IF NOT EXISTS peer_usage (share_id TEXT NOT NULL, day TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (share_id, day))`);
      // Requester side: shares this side removed. The server can't bring them back by replaying an old grant.
      g.exec(`CREATE TABLE IF NOT EXISTS peer_removed (share_id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL)`);
      // Owner side: agents created as guest versions here (their restrictions are checked on every turn).
      // Keys the user compared out of band and marked as verified (a row per share where it was marked; the key
      // counts as verified on every share with it, a different key doesn't).
      g.exec(`CREATE TABLE IF NOT EXISTS peer_key_verified (share_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, verified_at INTEGER NOT NULL)`);
      g.exec(`CREATE TABLE IF NOT EXISTS peer_guest_agents (agent_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`);
      // Each contact's key, by their gateway id, pinned on first use (either direction). A share can't bring
      // another key for that gateway; only the owner can accept a changed one (trustNewKey).
      g.exec(`CREATE TABLE IF NOT EXISTS peer_gateway_keys (gateway_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL)`);
      // Requester side: the owner gateway a share's pinned key signed for (ownerOf, also once the share has ended).
      if (!g.prepare('PRAGMA table_info(peer_pins)').all().some(c => c.name === 'owner_gateway_id')) g.exec('ALTER TABLE peer_pins ADD COLUMN owner_gateway_id TEXT');
      // Gateways already approved here keep the key they were approved with (newest grant first).
      for (const r of g.prepare('SELECT grant_json FROM peer_grants WHERE revoked_at IS NULL ORDER BY created_at DESC').all()) {
        try {
          const gr = JSON.parse(r.grant_json);
          if (gr.requesterGatewayId && gr.requesterPubKey) g.prepare('INSERT OR IGNORE INTO peer_gateway_keys (gateway_id, pubkey, created_at) VALUES (?, ?, ?)').run(gr.requesterGatewayId, gr.requesterPubKey, Date.now());
        } catch { /* unreadable grant */ }
      }
      this._ready = true;
    }
    return g;
  }

  // ── Share list (signal server) ─────────────────────────────────────

  /** `share-list` from the signal server. Ends links/grants for shares that are gone. */
  setShares(shares) {
    this._nameCache = null;
    const first = !this.serverEnabled;
    this.serverEnabled = true;
    this._shares = Array.isArray(shares) ? shares : [];
    const live = new Set(this._shares.filter(s => s.status === 'active').map(s => s.id));
    for (const [shareId, link] of this._links) if (!live.has(shareId)) { link.close(); this._links.delete(shareId); }
    for (const s of this._localGrants()) if (!live.has(s.share_id) && !this._shares.some(x => x.id === s.share_id && x.status === 'pending')) this._revokeLocal(s.share_id);
    this._changed();
    if (first) setImmediate(() => { try { this.onFirstShares?.(); } catch (e) { this.log.warn?.(`[sharing] ${e.message}`); } });
    if (first) setImmediate(() => this.migrateContacts().catch(e => this.log.warn?.(`[sharing] contact migration: ${e.message}`)));
    this._sharesChanged();
    this._presenceTick();
  }

  /**
   * Presence: a gateway that asked for someone's agents is the one that can open the link to them, so
   * it keeps one open (and re-opens it when it drops). Without that, a room host that only *granted*
   * shares couldn't reach its people until they happened to use an agent: copies would sit unsent.
   * Retries back off per share (15 s up to 10 min); a failed dial costs nothing.
   */
  _presenceTick() {
    clearTimeout(this._presenceTimer);
    if (!this.serverEnabled || this._closed) return;
    for (const s of this._shares) {
      if (s.as !== 'requester' || s.status !== 'active' || !this._verifiedGrant(s)) continue;
      const cur = this._links.get(s.id);
      const b = (this._backoff ??= new Map());
      if ((cur?.ready && !cur.closed) || this._linking.has(s.id)) { b.delete(s.id); continue; }
      const st = b.get(s.id) || { next: 0, wait: 15_000 };
      if (Date.now() < st.next) continue;
      b.set(s.id, { next: Date.now() + st.wait, wait: Math.min(st.wait * 2, 10 * 60_000) });
      this._link(s.id).then(() => b.delete(s.id)).catch(e => this.log.info?.(`[sharing] presence ${s.id}: ${e.message}`));
    }
    this._presenceTimer = setTimeout(() => this._presenceTick(), 15_000);
    this._presenceTimer.unref?.();
  }

  /** Team chats follow the connection: people and agents of an ended share leave their rooms. */
  _sharesChanged() { try { this.onSharesChanged?.(); } catch (e) { this.log.warn?.(`[sharing] ${e.message}`); } }

  /** The signal server says a share ended (revoke/decline): stop at once. */
  onShareRevoked(shareId) {
    this._revokeLocal(shareId);
    this._links.get(shareId)?.close();
    this._links.delete(shareId);
    this._changed();
    this._sharesChanged();
  }

  _changed() { this.broadcast(JSON.stringify({ type: 'clawchats', event: 'sharing-changed' })); }

  /** Shares for the ClawChats UI, with what this side has verified. */
  list() {
    return this._shares.map(s => {
      const out = { id: s.id, as: s.as, status: s.status, createdAt: s.createdAt, requester: s.requester, owner: s.owner, agents: s.agents || [] };
      // Key fingerprints computed here from the keys this side actually uses (not the server's word),
      // for comparing out of band: the grant's pinned requester key, or the pinned owner key.
      if (s.as === 'owner') {
        const g = this._grant(s.id);
        out.access = g?.grant.access || null;
        out.autonomy = g?.grant.autonomy || null;
        out.person = personKeyOf(s.requester?.email) || null;
        const c = out.person && this.book.get(out.person);
        if (c) {
          const u = this.book.usage(c.personKey), t = AUTONOMY[c.autonomy] || AUTONOMY.bounded;
          out.contact = { access: c.access, autonomy: c.autonomy, knowledge: c.knowledge, migrated: c.migrated, usedToday: u.day, usedHour: u.hour, perDay: t.perDay, perHour: t.perHour || null };
          // Read by the older People view (no contact cards): "N of M replies today".
          out.usedToday = u.day;
          out.dailyCap = t.perDay;
        }
        const key = g?.grant.requesterPubKey || s.requester?.pubKey;
        out.theirKey = key ? fingerprint(key) : null;
        out.keyVerified = !!key && this._keyVerified(s.id, key);
      } else {
        const vg = this._verifiedGrant(s);
        out.verified = !!vg;
        // What they let this side's person do (the popover's "Kamil's for you" line, and the rounds cap).
        out.theirAccess = vg?.access || null;
        out.theirAutonomy = vg ? (AUTONOMY[vg.autonomy] ? vg.autonomy : 'bounded') : null;
        const pin = this._theirKey(s);
        out.theirKey = pin ? fingerprint(pin) : null;
        out.keyVerified = !!pin && this._keyVerified(s.id, pin);
      }
      // The server shows a different key for them than the one pinned for their gateway: refused until the owner trusts it.
      const presented = s.as === 'owner' ? s.requester?.pubKey : s.owner?.pubKey;
      const pinned = this._gatewayKey(this._other(s).gatewayId);
      out.keyChanged = !!(presented && pinned && presented !== pinned);
      // What "Trust new key" would accept, as fingerprints to compare with the contact out of band.
      if (out.keyChanged) out.keyChange = { was: fingerprint(pinned), now: fingerprint(presented) };
      // Their connector is older than this one accepts (seen on a link): nothing is shared until they update.
      const gw = this._other(s).gatewayId;
      if (gw && this._peerVersions.has(gw) && peerOutdated(this._peerVersions.get(gw))) {
        out.needsUpdate = { version: this._peerVersions.get(gw), message: outdatedMessage(this._other(s).name.split(/\s/)[0], this._peerVersions.get(gw)) };
      }
      return out;
    });
  }

  /** The key pinned for a contact's gateway, or null before first use. */
  _gatewayKey(gatewayId) {
    return gatewayId ? this._db().prepare('SELECT pubkey FROM peer_gateway_keys WHERE gateway_id = ?').get(gatewayId)?.pubkey || null : null;
  }

  /** Pin a gateway's key on first use. False when another key is pinned for it. */
  _pinGatewayKey(gatewayId, pubKey) {
    if (!gatewayId || !pubKey) return false;
    this._db().prepare('INSERT OR IGNORE INTO peer_gateway_keys (gateway_id, pubkey, created_at) VALUES (?, ?, ?)').run(gatewayId, pubKey, Date.now());
    return this._gatewayKey(gatewayId) === pubKey;
  }

  /**
   * The owner accepts the key the server now shows for this share's other side (they reinstalled, say),
   * after checking it with them. Until then a changed key is refused on every share with that gateway.
   */
  trustNewKey(shareId) {
    const s = this._shares.find(x => x.id === shareId);
    const gw = s && this._other(s).gatewayId;
    const key = s?.as === 'owner' ? s.requester?.pubKey : s?.owner?.pubKey;
    if (!gw || !key) throw new Error('Nothing to trust yet');
    this._db().prepare('INSERT OR REPLACE INTO peer_gateway_keys (gateway_id, pubkey, created_at) VALUES (?, ?, ?)').run(gw, key, Date.now());
    // Every share with that gateway follows (the card trusts from whichever direction; the pins are per share).
    for (const x of this._shares) if (x.as === 'requester' && x.owner?.gatewayId === gw) this._db().prepare('DELETE FROM peer_pins WHERE share_id = ?').run(x.id);
    this._nameCache = null;
    this._changed();
    this._sharesChanged();
    return { theirKey: fingerprint(key) };
  }

  /** The other side's key this gateway trusts for a share (owner: from the signed grant, or the request's key
   *  while pending, which approving pins; requester: the pin). Same source as list()'s "Their key". */
  _theirKey(s) {
    if (s?.as === 'owner') return this._grant(s.id)?.grant.requesterPubKey || s.requester?.pubKey || null;
    return this._db().prepare('SELECT owner_pubkey FROM peer_pins WHERE share_id = ?').get(s?.id)?.owner_pubkey || null;
  }

  /** A key compared once is verified on every share with that gateway (a share's own row records where it was done). */
  _keyVerified(shareId, pubKey) {
    return !!this._db().prepare('SELECT 1 FROM peer_key_verified WHERE pubkey = ? LIMIT 1').get(pubKey);
  }

  /** The user compared "Their key" with the other person (by phone, chat…) and it matched. */
  markKeyVerified(shareId) {
    const key = this._theirKey(this._shares.find(x => x.id === shareId));
    if (!key) throw new Error('Nothing to verify yet');
    this._db().prepare('INSERT OR REPLACE INTO peer_key_verified (share_id, pubkey, verified_at) VALUES (?, ?, ?)').run(shareId, key, Date.now());
    this._changed();
    return { theirKey: fingerprint(key) };
  }

  // ── Owner side ─────────────────────────────────────────────────────

  _localGrants() { return this._db().prepare('SELECT * FROM peer_grants WHERE revoked_at IS NULL').all(); }

  _grant(shareId) {
    const r = this._db().prepare('SELECT * FROM peer_grants WHERE share_id = ? AND revoked_at IS NULL').get(shareId);
    return r ? { grant: JSON.parse(r.grant_json), sig: r.sig } : null;
  }

  _revokeLocal(shareId) {
    this._db().prepare('UPDATE peer_grants SET revoked_at = ? WHERE share_id = ? AND revoked_at IS NULL').run(Date.now(), shareId);
    for (const link of this._served) if (link.shareId === shareId) link.close();
    // Runs already going stop too: "Stop sharing" must not leave a guest run working for minutes. One still
    // being set up is marked, so it never starts (or is aborted the moment it has started).
    for (const t of this._turns.values()) if (t.shareId === shareId) this._abortTurn(t);
  }

  _abortTurn(t) {
    t.aborted = true;
    if (t.runId) this.chatAbort.abort({ sessionKey: t.sessionKey, runId: t.runId, sessionId: t.sessionId }).catch(() => {});
  }

  /** Remember an agent created here as a guest version (ClawChats → Sharing). */
  /**
   * The signal server refused a grant (it never activated the share). The owner is told, and a grant that was only
   * pending is dropped, so both sides agree the share isn't there. A grant for a share that was already active
   * (an edit the server turned down) stays: the share still works as it did.
   */
  onGrantRejected(shareId) {
    const live = this._shares.find(x => x.id === shareId && x.as === 'owner');
    if (live?.status !== 'active') this._db().prepare('DELETE FROM peer_grants WHERE share_id = ?').run(shareId);
    this.broadcast?.(JSON.stringify({
      type: 'clawchats', event: 'sharing-error', shareId,
      message: live?.status === 'active' ? "The server didn't accept that change. Your sharing is as it was; try again." : "The server didn't accept it. Try again.",
    }));
    this._changed();
  }

  /** Ids of the guest agents this connector made (the gateway may show them under another name). */
  guestAgentIds() {
    return new Set([...this._db().prepare('SELECT agent_id FROM peer_guest_agents').all().map(r => r.agent_id), ...this.book.copyIds()]);
  }

  markGuestAgent(agentId) {
    this._db().prepare('INSERT OR IGNORE INTO peer_guest_agents (agent_id, created_at) VALUES (?, ?)').run(agentId, Date.now());
  }

  /**
   * Bring every guest version made here up to the current guest policy, on each gateway connect,
   * so a tightened policy reaches existing guests without the owner re-approving their shares.
   * Skips agents that no longer exist (patching them would leave a stray config entry).
   */
  async migrateGuestAgents() {
    const ids = this._db().prepare('SELECT agent_id FROM peer_guest_agents').all().map(r => r.agent_id);
    if (!ids.length) return [];
    const live = new Set(((await this.request('agents.list', {}))?.agents || []).map(a => a.id));
    const updated = [];
    for (const id of ids.filter(i => live.has(i))) {
      try { if (await ensureGuestRestrictions(this.request, id)) updated.push(id); }
      catch (e) { this.log.warn?.(`[sharing] couldn't update guest restrictions for ${id}: ${e.message}`); }
    }
    if (updated.length) this.log.info?.(`[sharing] guest restrictions updated: ${updated.join(', ')}`);
    return updated;
  }

  /**
   * Approve (or change) a share: sign and store the grant (v2: agents, access, autonomy), send it to the signal server.
   * The person's contact card is created on first approval (with `contact`: the first-time form's settings) and keeps
   * access, autonomy and agents in step with the grant. `dailyCap` (older ClawChats) maps to an autonomy tier.
   */
  approve(shareId, { agents, access = 'restricted', autonomy = null, dailyCap = null, contact = null, confirmFull = false } = {}) {
    const s = this._shares.find(x => x.id === shareId && x.as === 'owner' && ['pending', 'active'].includes(x.status));
    if (!s) throw new Error('No such request');
    if (!s.requester?.pubKey || !s.requester?.gatewayId) throw new Error("The requester's gateway hasn't connected with sharing support yet");
    const list = (Array.isArray(agents) ? agents : []).filter(a => a && typeof a.id === 'string' && a.id).map(a => ({ id: a.id, name: String(a.name || a.id).slice(0, 80) }));
    // No agents is fine: a connection can be just for chatting (team chats with people).
    if (!ACCESS.includes(access)) throw new Error('Unknown access level');
    autonomy = AUTONOMY[autonomy] ? autonomy : dailyCap != null ? autonomyFromCap(dailyCap) : (this.book.get(s.requester.email)?.autonomy || 'bounded');
    // A changed grant keeps the requester key it was first approved for: the signal server can't swap it.
    const prev = this._db().prepare('SELECT grant_json FROM peer_grants WHERE share_id = ?').get(shareId);
    if (prev && JSON.parse(prev.grant_json).requesterPubKey !== s.requester.pubKey) {
      throw new Error("The requester's gateway key changed since you approved them. Stop sharing and ask them to request again.");
    }
    // Nor can a new request bring another key for a gateway this one already knows (a server posing as them).
    const pinned = this._gatewayKey(s.requester.gatewayId);
    if (pinned && pinned !== s.requester.pubKey) {
      throw new Error(`${cleanName(s.requester.name || s.requester.email, 60) || 'Their'} gateway key isn't the one you connected with before. Check "Their key" with them, then trust the new key.`);
    }
    // The signal server only activates a grant signed for this gateway's own id; without one it would say no, silently.
    const ownerGatewayId = this.gatewayId();
    if (!ownerGatewayId) throw new Error("This gateway isn't connected to the signal server yet. Try again in a moment.");
    // The contact card: made on first approval, then access/autonomy/agents follow the grant.
    const person = personKeyOf(s.requester.email);
    if (person) {
      const had = this.book.get(person);
      if (access === 'full' && !had?.fullConfirmedAt && !confirmFull && !contact?.fullConfirmedAt) throw Object.assign(new Error('Full agent needs confirming'), { code: 'confirm_full' });
      if (!had) {
        const sources = list.map(a => a.id);
        // Without the card's first-time form (an older ClawChats app), nothing of the owner's notes is shared.
        this.book.create(person, { ...defaultContact(access), ...(contact ? {} : { knowledge: 'none' }), ...(contact || {}), name: cleanName(s.requester.name, 60) || null, access, autonomy, agents: sources, ...(access === 'full' ? { fullConfirmedAt: Date.now() } : {}) });
      } else {
        // Accepting again (they reconnected): the form started from the old card; what was changed on it is saved.
        // Access first: it resets Tools and Commands to that tier, which the form's own values then override.
        if (had.access !== access) this.book.set(person, 'access', access, { confirmFull: true });
        const now = this.book.get(person);
        for (const f of ['knowledge', 'notes', 'repos', 'tools', 'commands', 'skills', 'mcp', 'private', 'alwaysFine', 'basicList']) {
          if (contact && contact[f] !== undefined && JSON.stringify(contact[f]) !== JSON.stringify(now[f])) this.book.set(person, f, contact[f]);
        }
        if (had.autonomy !== autonomy) this.book.set(person, 'autonomy', autonomy);
        const ids = list.map(a => this._sourceIdSync(a.id));
        if (JSON.stringify([...(had.agents || [])].sort()) !== JSON.stringify([...ids].sort())) this.book.set(person, 'agents', ids);
      }
    }
    const grant = {
      v: 2, shareId, ownerGatewayId, requesterGatewayId: s.requester.gatewayId, requesterPubKey: s.requester.pubKey,
      requesterName: cleanName(s.requester.name || s.requester.email, 60) || null,
      agents: list, access, autonomy, issuedAt: Date.now(),
    };
    const sig = this.key.signJson(grant);
    this._pinGatewayKey(grant.requesterGatewayId, grant.requesterPubKey);
    this._db().prepare('INSERT INTO peer_grants (share_id, grant_json, sig, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(share_id) DO UPDATE SET grant_json = excluded.grant_json, sig = excluded.sig, created_at = excluded.created_at, revoked_at = NULL')
      .run(shareId, JSON.stringify(grant), sig, Date.now());
    // An agent removed from the grant: its links pick up the new list on the next turn.
    this.signal({ type: 'share-grant', shareId, grant, signature: sig });
    this._changed();
    return grant;
  }

  /** Stop a share from this side (owner or requester). Enforced locally first, then told to the server. */
  revoke(shareId) {
    if (this._shares.find(x => x.id === shareId)?.as === 'requester') {
      this._db().prepare('INSERT OR IGNORE INTO peer_removed (share_id, removed_at) VALUES (?, ?)').run(shareId, Date.now());
    }
    this.onShareRevoked(shareId);
    this.signal({ type: 'share-revoke', shareId });
  }

  /** Replies counted today for the person behind a share (one counter per person). */
  _usage(shareId) {
    const person = this._personOfShare(shareId);
    return person ? this.book.usage(person).day : 0;
  }

  /** Whether this side would serve a peer connection for the share (checked before any WebRTC setup). */
  acceptsPeer(shareId, requesterGatewayId) {
    const g = this._grant(shareId);
    return !!g && g.grant.requesterGatewayId === requesterGatewayId;
  }

  /**
   * An inbound peer DataChannel (owner side). Served only for a local unrevoked grant whose
   * requester gateway matches, authenticated against the key pinned in that grant.
   */
  servePeer({ dc, dtls, shareId, requesterGatewayId }) {
    const g = this._grant(shareId);
    if (!g || g.grant.requesterGatewayId !== requesterGatewayId) {
      this.log.warn?.(`[sharing] refused peer link for ${shareId}: no grant`);
      try { dc.close(); } catch { /* gone */ }
      return null;
    }
    const link = new PeerLink({ dc, dtls, role: 'owner', shareId, key: this.key, peerKey: g.grant.requesterPubKey, log: this.log, version: this.version });
    const gw = g.grant.requesterGatewayId; // the gateway the key this link authenticates was approved for
    this._served.add(link);
    link.on('closed', () => this._served.delete(link));
    // A connector older than this one accepts gets every request refused with what to do (it shows the message), and
    // nothing of this side's rooms; checked at the handshake and again before every turn.
    const current = fn => (p, emit) => {
      if (this._checkPeer(link, gw)) return Promise.reject(Object.assign(new Error(outdatedMessage(null, link.peerVersion)), { code: 'peer_outdated' }));
      return fn(p, emit);
    };
    link.handle('agents', current(this._limited(gw, 'agents', async () => ({ agents: this._grant(shareId)?.grant.agents || [] }))));
    link.handle('turn', current(this._limited(gw, 'turn', (p, emit) => this._guestTurn(shareId, { ...p, inOwnerRoom: false, byPerson: false }, emit)))); // only localTurnFor sets these
    link.handle('abort', this._limited(gw, 'abort', async p => this._guestAbort(shareId, p?.turnId)));
    this._wireRooms(link, gw, current);
    return link;
  }

  /** A peer request handler, refused once that contact's gateway goes over its rate (PEER_RATES). */
  _limited(gatewayId, method, fn) {
    return (p, emit) => {
      const kind = PEER_RATES[method] ? method : '*';
      const [burst, per] = PEER_RATES[kind];
      const now = Date.now();
      const key = `${gatewayId}|${kind}`;
      const b = this._buckets.get(key) || { tokens: burst, at: now };
      b.tokens = Math.min(burst, b.tokens + ((now - b.at) * burst) / per);
      b.at = now;
      this._buckets.set(key, b);
      if (b.tokens < 1) {
        this.log.warn?.(`[sharing] ${gatewayId} is sending too many ${kind === '*' ? 'requests' : kind} requests: refused`);
        return Promise.reject(Object.assign(new Error('Too many requests; try again in a moment'), { code: 'rate_limited' }));
      }
      b.tokens -= 1;
      return fn(p, emit);
    };
  }

  /**
   * Team chats with people (specs/sharing-people.md) travel over whichever link the two gateways
   * have, in either direction: the room host pushes its room to members (room.sync), members post,
   * leave and ask for a fresh copy (room.post / room.leave / room.fetch). `onRoom` (TeamCoordinator)
   * decides; it gets the other side's gateway id, which the link authenticated.
   */
  _wireRooms(link, otherGatewayId, current = fn => fn) {
    for (const method of ['room.sync', 'room.post', 'room.leave', 'room.fetch']) {
      link.handle(method, current(this._limited(otherGatewayId, method, async p => {
        if (!this.onRoom) throw Object.assign(new Error('team chats are not available'), { code: 'unavailable' });
        return this.onRoom(method, p || {}, otherGatewayId);
      })));
    }
    const ready = () => {
      if (this._checkPeer(link, otherGatewayId)) return; // too old: no room pushes either way
      try { this.onPeerReady?.(otherGatewayId); } catch (e) { this.log.warn?.(`[sharing] peer ready: ${e.message}`); }
    };
    if (link.ready) setImmediate(ready); else link.once('ready', ready);
  }

  // ── People (contacts) ──────────────────────────────────────────────

  /** The other person of a share, as this side sees them: { gatewayId, name, email }. */
  _other(s) {
    const p = s.as === 'owner' ? s.requester : s.owner;
    // Their gateway as this side signed or verified it, not as the server lists it now.
    const gatewayId = s.as === 'owner' ? this._grant(s.id)?.grant.requesterGatewayId || p?.gatewayId : this._ownerGateway(s) || p?.gatewayId;
    return { gatewayId: gatewayId || null, name: cleanName(p?.name || p?.email, 60) || 'Someone', email: p?.email || null };
  }

  /**
   * People this gateway is connected with (an active share either way), by their gateway id:
   * [{ personId, name, email, shareIds }]. A team chat here can include any of them.
   */
  contacts() {
    const out = new Map();
    for (const s of this._shares) {
      if (s.status !== 'active') continue;
      if (s.as === 'requester' && !this._verifiedGrant(s)) continue;
      if (s.as === 'owner' && !this._grant(s.id)) continue;
      const o = this._other(s);
      if (!o.gatewayId) continue;
      const c = out.get(o.gatewayId) || { personId: o.gatewayId, name: o.name, email: o.email, shareIds: [] };
      c.shareIds.push(s.id);
      out.set(o.gatewayId, c);
    }
    return [...out.values()];
  }

  contact(personId) { return this.contacts().find(c => c.personId === personId) || null; }

  /** Whether any share (either direction, verified or not) is active with that gateway. */
  hasShareWith(gatewayId) {
    return this._shares.some(s => s.status === 'active' && this._other(s).gatewayId === gatewayId);
  }

  /**
   * How a person's name shows next to their agents ("Jarvis · Kamil"): the first name, or the full
   * name when two people here (this gateway's person included) share a first name.
   */
  labelOf(gatewayId, fullName) {
    const first = n => cleanName(String(n || '').trim().split(/[\s@]/)[0], 30) || 'Someone';
    // Everyone known here by id (cached: remoteAgents() calls this per agent, and contacts() verifies grants).
    if (!this._nameCache || Date.now() - this._nameCache.at > 5000) {
      const known = new Map();
      for (const c of this.contacts()) known.set(c.personId, c.name);
      if (this.gatewayId?.()) known.set(this.gatewayId(), this.selfName() || '');
      this._nameCache = { at: Date.now(), known };
    }
    const people = new Map(this._nameCache.known);
    if (gatewayId && fullName) people.set(gatewayId, fullName);
    const mine = first(fullName);
    const clash = [...people].some(([id, n]) => id !== gatewayId && first(n).toLowerCase() === mine.toLowerCase());
    return clash ? cleanName(fullName, 60) || mine : mine;
  }

  /** The room (and who asked) behind a guest session of this gateway, or null. */
  /** Sessions here answering `roomId` of the room hosted by `hostGatewayId` (hidden from the list while a copy exists). */
  guestSessionKeysFor(hostGatewayId, roomId) {
    const keys = [];
    for (const r of this._db().prepare('SELECT p.session_key, g.grant_json FROM peer_sessions p JOIN peer_grants g ON g.share_id = p.share_id WHERE p.room_id = ?').all(roomId)) {
      try { if (JSON.parse(r.grant_json).requesterGatewayId === hostGatewayId) keys.push(r.session_key); } catch { /* unreadable grant */ }
    }
    return keys;
  }

  guestSessionOf(key) {
    if (!this._guestKeys) {
      this._guestKeys = new Map();
      for (const r of this._db().prepare('SELECT share_id, room_id, session_key FROM peer_sessions').all()) {
        const g = this._grant(r.share_id);
        if (g?.grant.requesterGatewayId) this._guestKeys.set(r.session_key, { requesterGatewayId: g.grant.requesterGatewayId, roomId: r.room_id, shareId: r.share_id });
      }
    }
    return this._guestKeys.get(key) || null;
  }

  /** The gateway id of whoever owns a shared agent ('peer:<share>:<agent>'), or null. */
  ownerOf(remoteAgentId) {
    const id = SharingManager.parseRemoteId(remoteAgentId);
    return id ? this._ownerGateway(this._shares.find(s => s.id === id.shareId && s.as === 'requester')) : null;
  }

  /**
   * The owner gateway of a share shared with this one: the id its grant was signed for by the key pinned
   * for it (the server's word alone can't make it someone else). Remembered after the share ends.
   */
  _ownerGateway(s) {
    if (!s) return null;
    const g = this._verifiedGrant(s);
    if (g) return g.ownerGatewayId;
    const pin = this._db().prepare('SELECT owner_pubkey, owner_gateway_id FROM peer_pins WHERE share_id = ?').get(s.id);
    if (pin?.owner_gateway_id) return pin.owner_gateway_id;
    // Pinned before the owner gateway was recorded with it: the grant still says, if the pinned key signed it.
    const ok = pin && s.grant && s.grant.ownerGatewayId === s.owner?.gatewayId && verifySignature(pin.owner_pubkey, canonicalJson(s.grant), s.signature);
    return ok ? s.grant.ownerGatewayId : null;
  }

  /** Whether this gateway owns (granted) that share. */
  ownsShare(shareId) { return !!this._grant(shareId); }

  /** Whether this gateway shares `agentId` with that gateway (an unrevoked grant it signed; only that share, if given). */
  grantedTo(gatewayId, agentId, shareId = null) {
    if (!gatewayId || !agentId) return false;
    return this._localGrants().some(r => {
      if (shareId && r.share_id !== shareId) return false;
      try {
        const g = JSON.parse(r.grant_json);
        return g.requesterGatewayId === gatewayId && (g.agents || []).some(a => a?.id === agentId);
      } catch { return false; }
    });
  }

  /** This gateway's person, as the others see them (from any share). */
  selfName() {
    for (const s of this._shares) {
      const me = s.as === 'owner' ? s.owner : s.requester;
      if (me?.name || me?.email) return cleanName(me.name || me.email, 60);
    }
    return null;
  }

  /** An open link with that person's gateway (either direction), else dial one this side may open. */
  async _personLink(personId) {
    for (const [shareId, link] of this._links) {
      const s = this._shares.find(x => x.id === shareId);
      if (link.ready && !link.closed && s && this._other(s).gatewayId === personId) return link;
    }
    for (const link of this._served) {
      if (link.ready && !link.closed && this._grant(link.shareId)?.grant.requesterGatewayId === personId) return link;
    }
    const dial = this._shares.find(s => s.as === 'requester' && s.status === 'active' && s.owner?.gatewayId === personId && this._verifiedGrant(s));
    if (!dial) throw Object.assign(new Error(`Can't reach them until they're online`), { code: 'unreachable' });
    return this._link(dial.id);
  }

  /** Call a room method on a person's gateway. */
  async personRequest(personId, method, params, { timeoutMs = 60_000 } = {}) {
    if (!this.contact(personId)) throw Object.assign(new Error('Not connected with them'), { code: 'not_connected' });
    const link = await this._personLink(personId);
    if (this._checkPeer(link, personId)) throw Object.assign(new Error(outdatedMessage(this.contact(personId)?.name?.split(/\s/)[0] || 'Their', link.peerVersion)), { code: 'peer_outdated' });
    return link.request(method, params, { timeoutMs });
  }

  /** Run one guest turn in this gateway's session for (share, room, agent); stream text back. */
  async _guestTurn(shareId, p, emit) {
    const g = this._grant(shareId);
    if (!g) throw Object.assign(new Error('Sharing has ended'), { code: 'revoked' });
    const { grant } = g;
    const agent = grant.agents.find(a => a.id === p.agentId);
    if (!agent) throw Object.assign(new Error('That agent is not shared'), { code: 'not_shared' });
    const roomId = String(p.roomId || '').slice(0, 200);
    if (!roomId || typeof p.message !== 'string' || !p.message.trim()) throw Object.assign(new Error('Bad turn'), { code: 'bad_request' });
    // The requester's turn id only names the turn (for its Stop, and for a resend after its link dropped); the turn
    // itself is tracked under an id made here, so reusing one can't hide a turn from the limit or from "Stop sharing".
    const clientTurnId = typeof p.turnId === 'string' && p.turnId ? p.turnId.slice(0, 200) : null;
    const same = JSON.stringify([agent.id, roomId, p.message]); // what a resend repeats exactly
    const recentKey = clientTurnId && `${shareId}|${clientTurnId}`;
    if (clientTurnId) {
      const live = [...this._turns.values()].find(t => t.shareId === shareId && t.clientTurnId === clientTurnId);
      const done = !live && this._recentTurn(recentKey);
      if ((live || done) && (live || done).same !== same) throw Object.assign(new Error('That turn was already sent with another message'), { code: 'bad_request' });
      // A resend: no new run, and it isn't counted again.
      if (live) return this._reattach(live, emit);
      if (done?.error) throw Object.assign(new Error(done.error.message), { code: done.error.code, partial: done.error.partial });
      if (done) return { ...done.result };
    }
    // The person's contact card decides (one counter per person across their gateways, D10).
    const person = this._personOfShare(shareId);
    const contact = person && this._contactFor(person, grant);
    if (!contact) throw Object.assign(new Error('Sharing has ended'), { code: 'revoked' });
    const tier = AUTONOMY[contact.autonomy] || AUTONOMY.bounded;
    // Autonomy: their agents may start a reply of ours only within the tier's rounds (Notify only: never; the person
    // can still ask). The host says what triggered the turn; a host that doesn't say counts as a person asking.
    const round = Math.max(0, Math.floor(Number(p.round) || 0));
    if (p.trigger === 'agent' && tier.rounds === 0) throw Object.assign(new Error(`Your agents don't answer ${firstName({ name: grant.requesterName })}'s agents on their own (Notify only)`), { code: 'notify_only' });
    if (p.trigger === 'agent' && round > tier.rounds) throw Object.assign(new Error(`Agents paused after ${tier.rounds} rounds; reply to continue`), { code: 'rounds' });
    const capped = this.book.overCap(person, contact.autonomy);
    if (capped) throw Object.assign(new Error(capped), { code: 'cap' });
    const running = [...this._turns.values()].filter(t => t.shareId === shareId);
    if (running.length >= MAX_CONCURRENT_TURNS) throw Object.assign(new Error('Too many replies at once; try again shortly'), { code: 'busy' });
    const turnKey = crypto.randomUUID();
    // Everything the guest's agent says leaves this gateway (to the other person, or into a room they see). The
    // gateway stopped masking secrets in tool output in 2026.10.10, so a credential an agent read can come out in
    // its reply: redact it here (util/redact.js), in the streamed text, the final one and a failed turn's partial.
    // `emit` is the link that asked last (a resend after a dropped link takes over the stream).
    const turn = { shareId, clientTurnId, same, sessionKey: null, runId: null, sessionId: null, aborted: false, emit: redacting(emit), result: null };
    this._turns.set(turnKey, turn); // counts toward the limit from here on
    // Counted before any await, so parallel turns can't both pass the cap.
    this.book.count(person, 1);
    this._changed(); // the owner's Sharing view shows today's count
    turn.result = (async () => {
      try {
        const r = await this._runGuestTurn(shareId, grant, agent, roomId, p, (event, data) => turn.emit?.(event, data), turn, contact);
        if (typeof r?.text === 'string') r.text = redactSecrets(r.text);
        // What this gateway's agent said for that gateway's room: its copy of the room may show it as ours (team.js).
        if (!p.inOwnerRoom && r?.text) try { this.onGuestReply?.(grant.requesterGatewayId, roomId, shareId, agent.id, r.text); } catch { /* best effort */ }
        if (recentKey) this._rememberTurn(recentKey, { same, result: { ...r } });
        return r;
      }
      catch (e) {
        if (typeof e?.partial === 'string') e.partial = redactSecrets(e.partial);
        // A reply that failed without saying anything doesn't use up the day's replies. A timeout still
        // counts: it ran for the full turn timeout.
        if (!e.partial && !/timed out/i.test(e.message)) {
          this.book.count(person, -1);
          this._changed();
        }
        if (recentKey) this._rememberTurn(recentKey, { same, error: { message: e.message, code: e.code, partial: e.partial } });
        throw e;
      }
      finally { this._turns.delete(turnKey); }
    })();
    return turn.result;
  }

  /** A resend of a turn still running here (its link dropped): the new link gets the text so far, then the same result. */
  _reattach(turn, emit) {
    turn.emit = redacting(emit);
    const run = turn.runId && this._runs.get(turn.runId);
    if (run?.text) turn.emit?.('delta', run.text); // deltas are cumulative
    if (run?.waiting) turn.emit?.('status', { waiting: 'approval', what: run.waiting.what, expiresAtMs: run.waiting.expiresAtMs });
    return turn.result;
  }

  _recentTurn(key) {
    const e = this._finished.get(key);
    return e && Date.now() - e.at < RECENT_TURN_MS ? e : null;
  }

  /** Keep a finished turn's result (already redacted) for a while, oldest dropped first. */
  _rememberTurn(key, entry) {
    this._finished.delete(key);
    this._finished.set(key, { ...entry, at: Date.now() });
    for (const [k, e] of this._finished) {
      if (this._finished.size <= RECENT_TURNS_MAX && Date.now() - e.at < RECENT_TURN_MS) break;
      this._finished.delete(k);
    }
  }

  async _runGuestTurn(shareId, grant, agent, roomId, p, emit, turn, contact) {
    // The person's own copy of the agent (D3), brought up to the card's policy; notes synced if they changed.
    const sourceId = await this._sourceId(agent.id);
    if (Array.isArray(contact.agents) && !contact.agents.map(id => this._sourceIdSync(id)).includes(sourceId)) throw Object.assign(new Error('That agent is not shared'), { code: 'not_shared' });
    const copyId = await this._ensureCopy(contact, sourceId, firstName({ name: grant.requesterName }));
    const cfg = await this.request('config.get', {}, 30_000);
    // A copy whose policy was edited away (e.g. in the Control UI) and couldn't be restored isn't served.
    // Saved but not applied: the running gateway still has the old policy until its reload lands (the check the
    // gateway's own CLI uses: configRevisionHash vs appliedConfigHash; missing hashes count as applied).
    const applied = !cfg?.configRevisionHash || !cfg?.appliedConfigHash || cfg.configRevisionHash === cfg.appliedConfigHash;
    if (applied) this._pendingCopies?.delete(copyId);
    if (!copyToolsHold(cfg?.parsed?.agents?.entries?.[copyId]?.tools, copyTools(contact, { reviewerModel: reviewerModelFor(cfg?.parsed) }))
      || this._pendingCopies?.has(copyId)) {
      this.log.warn?.(`[sharing] ${copyId} doesn't hold its contact policy: refusing turn for ${shareId}`);
      throw Object.assign(new Error(`${agent.name} isn't available right now`), { code: 'unavailable' });
    }
    this.book.touchCopy(copyId);

    // Their full name, as the approval screen shows it ("Shared with Houman Test").
    const name = String(grant.requesterName || 'Someone').replace(/[\n\r]/g, ' ').trim().slice(0, 60) || 'Someone';
    const permissionMode = sessionMode(contact);
    const skillNames = await this._skillNames(copyId);
    const toolOverrides = contactOverrides(contact, { skillNames, mcpServers: Object.keys(cfg?.parsed?.mcp?.servers || {}) });
    const sessionKey = await this._guestSession(shareId, roomId, copyId, { name, roomTitle: String(p.roomTitle || 'team chat').slice(0, 80), permissionMode, toolOverrides, cwd: contact.access === 'full' ? contact.openFolder : null });
    // Made from the requester's turn id when there is one: a resend (after a dropped link, or after this connector
    // restarted) reuses the idempotency key, so the gateway answers with the first run instead of starting another.
    const runId = turn.clientTurnId
      ? `peer-${crypto.createHash('sha256').update(`${shareId}|${turn.clientTurnId}`).digest('hex').slice(0, 32)}`
      : `peer-${crypto.randomUUID()}`;
    // Commands that may ask the owner ("Basic + ask me", or Auto-review's unsure cases): the approval connection stays up
    // for this turn, so the gateway keeps the approval pending until the owner answers (no tab open needed), and the
    // turn may run as long as that approval can wait.
    const asks = contact.commands === 'ask' || contact.commands === 'auto';
    const turnTimeout = asks ? APPROVAL_TURN_TIMEOUT_MS : TURN_TIMEOUT_MS;
    const releaseApprovals = asks && this.holdApprovals ? await this.holdApprovals().catch(() => null) : null;
    const done = new Promise(resolve => {
      const timer = setTimeout(() => { this._runs.delete(runId); resolve({ state: 'error', errorMessage: 'timed out' }); }, turnTimeout + 30_000);
      timer.unref?.();
      this._runs.set(runId, { resolve, timer, text: '', emit, sessionKey });
    });
    Object.assign(turn, { sessionKey, runId });
    try {
      if (!this._grant(shareId)) throw Object.assign(new Error('Sharing has ended'), { code: 'revoked' }); // revoked while setting up
      if (turn.aborted) return { state: 'aborted', text: '' }; // stopped while setting up
      // A resend this connector has no record of (it restarted): if the turn's input is already in the session, the
      // transcript decides, not the ack. 2026.9.7 forgets its chat.send dedupe on a gateway restart and would start a
      // run with no new input (a reply to nothing). Only this connector reloaded, so its run is still going: the send
      // below is answered "in_flight" and the run's events finish the turn.
      const notes = [p.inOwnerRoom ? ACTING_FOR_NOTE(name, p.byPerson) : GUEST_NOTE(name), contact.access !== 'full' && contact.knowledge === 'notes' ? NOTES_NOTE(name) : '', topicsNote(contact, name.split(/\s/)[0])].filter(Boolean);
      const sent = defangLocalPaths(`${notes.join('\n')}\n\n${p.message}`);
      if (turn.clientTurnId) {
        const earlier = await this._replyTo(sessionKey, runId);
        if (earlier && earlier.input.trim() !== sent.trim()) throw Object.assign(new Error('That turn was already sent with another message'), { code: 'bad_request' });
        const s = earlier && await this.request('sessions.describe', { key: sessionKey }, 5000).then(r => r?.session || null, () => null);
        const ownRunGoing = s?.hasActiveRun !== false && (!Array.isArray(s?.activeRunIds) || s.activeRunIds.includes(runId));
        if (earlier && !ownRunGoing) return this._afterRestart(sessionKey, runId, turn);
      }
      const ack = await this.request('chat.send', {
        sessionKey, message: sent, deliver: false, idempotencyKey: runId,
        timeoutMs: turnTimeout, suppressCommandInterpretation: true,
        expectedPermissionMode: permissionMode, expectedToolOverrides: toolOverrides,
      }, 30_000).catch(e => {
        // The same key with another message (2026.11.5+): the requester has to resend the identical one.
        if (e?.details?.reason === 'chat-request-conflict') throw Object.assign(new Error('That turn was already sent with another message'), { code: 'bad_request' });
        throw e;
      });
      // The session the run started in: a later Stop is fenced to it.
      this.chatAbort.sessionIdOf(sessionKey).then(id => { turn.sessionId = id; });
      // Stopped or revoked while the send was on its way (the abort may have reached the gateway before the run).
      if (turn.aborted || !this._grant(shareId)) this._abortTurn(turn);
      // The gateway already has this input and nothing here tracked it (a resend after a restart): its reply is, or
      // will be, in the session. "in_flight" means it is still going: its events arrive as for a new run.
      if (ack?.status === 'ok') return this._afterRestart(sessionKey, runId, turn);
      const r = await done;
      if (r.state === 'final') return { state: 'final', text: r.message ? messageText(r.message) : await this._lastReply(sessionKey) };
      if (r.state === 'aborted') return { state: 'aborted', text: r.text || '' };
      // A host on an older connector still asks for NO_REPLY: on 2026.10.1+ that ends the run with an empty-reply
      // error and no final. Report it as an empty reply; the host treats that as a pass.
      if (!r.text && EMPTY_REPLY_ERROR.test(r.errorMessage || '')) return { state: 'final', text: '' };
      throw Object.assign(new Error(r.errorMessage || 'The agent run failed'), { code: 'run_failed', partial: r.text || '' });
    } finally {
      releaseApprovals?.();
      const run = this._runs.get(runId);
      if (run) { clearTimeout(run.timer); this._runs.delete(runId); }
      for (const [id, r] of this._approvalRuns || []) if (r === runId) this._approvalRuns.delete(id);
    }
  }


  // ── Contact cards (owner side) ─────────────────────────────────────

  /** The person (lowercased email) who asked for a share this gateway owns. */
  _personOfShare(shareId) {
    const s = this._shares.find(x => x.id === shareId && x.as === 'owner');
    return personKeyOf(s?.requester?.email) || null;
  }

  /** The person's contact; one made from their grant if migration hasn't run yet (a turn right after the update). */
  _contactFor(person, grant) {
    return this.book.get(person) || this.book.create(person, {
      ...defaultContact(grant.access === 'trusted' ? 'trusted' : 'restricted'), knowledge: 'none', migrated: true,
      name: grant.requesterName || null, autonomy: AUTONOMY[grant.autonomy] ? grant.autonomy : autonomyFromCap(grant.dailyCap),
      agents: (grant.agents || []).map(a => this._sourceIdSync(a.id)),
    });
  }

  /** The original agent behind a shared id: grants made before contact cards name the shared guest version ("main-guest"). */
  _sourceIdSync(id, agents = this._agentsCache || []) {
    const known = this.guestAgentIds();
    const a = agents.find(x => x.id === id);
    if (a && isGuestAgent(a, known)) {
      const src = agents.find(o => o.id !== id && !isGuestAgent(o, known) && findGuestAgent(agents, o.id, known)?.id === id);
      if (src) return src.id;
    }
    if (!a && known.has(id) && /-guest$/.test(id)) return id.replace(/-guest$/, '');
    return id;
  }

  async _agents() {
    this._agentsCache = (await this.request('agents.list', {}))?.agents || [];
    return this._agentsCache;
  }

  async _sourceId(id) { return this._sourceIdSync(id, await this._agents()); }

  /** The person's copy of an agent, written to the card's policy (one write at a time per copy); its notes synced. */
  async _ensureCopy(contact, sourceId, first) {
    const key = `${contact.personKey}|${sourceId}`;
    while (this._copying.has(key)) await this._copying.get(key).catch(() => {});
    const job = (async () => {
      const c = this.book.get(contact.personKey) || contact;
      const kind = copyKind(c);
      const r = await ensureContactCopy({ request: this.request, contact: c, agentId: sourceId, firstName: first, known: this.book.copy(c.personKey, sourceId, kind), log: this.log });
      this.book.putCopy(c.personKey, sourceId, kind, r.copyId, r.hash);
      if (r.pending) (this._pendingCopies ??= new Set()).add(r.copyId); // saved, not applied yet: not served until it is
      if (r.created) this._changed(); // agent pickers hide it
      if (kind === 'guest') await this._syncNotesFor(c, r.copyId);
      return r.copyId;
    })();
    this._copying.set(key, job);
    try { return await job; } finally { this._copying.delete(key); }
  }

  /** Workspaces of the agents shared with a person (where "My notes" come from). */
  async _noteCandidates(contact) {
    const agents = await this._agents();
    const known = this.guestAgentIds();
    const shared = agents.filter(a => !isGuestAgent(a, known) && (!Array.isArray(contact.agents) || contact.agents.map(id => this._sourceIdSync(id, agents)).includes(a.id)));
    return noteCandidates(shared.map(a => a.workspace));
  }

  /** The files a contact's notes are made of: their picks, or the defaults (all project notes but the infra ones). */
  async _notePicks(contact) {
    const cands = await this._noteCandidates(contact);
    const picks = Array.isArray(contact.notes) ? contact.notes : cands.filter(c => c.defaultOn).map(c => c.path);
    return { cands, files: resolvePicks(picks, cands) };
  }

  /** Copy the picked notes into a guest copy's folder when they changed (or `force`); "None" removes them. */
  async _syncNotesFor(contact, copyId, { force = false } = {}) {
    const ws = (this._agentsCache || []).find(a => a.id === copyId)?.workspace || (await this._agents()).find(a => a.id === copyId)?.workspace;
    if (!ws || !ws.startsWith('/')) return null;
    if (contact.knowledge !== 'notes') { removeNotes(ws); return null; }
    const { files } = await this._notePicks(contact);
    const sig = picksSignature(files);
    const last = contact.notesSync?.copies?.[copyId];
    if (!force && last === sig) return contact.notesSync;
    const r = syncNotes(ws, files);
    const summary = { ...r, copies: { ...(contact.notesSync?.copies || {}), [copyId]: r.signature } };
    this.book.setNotesSync(contact.personKey, summary);
    return summary;
  }

  async _skillNames(agentId) {
    const hit = this._skillsCache;
    if (hit && hit.agentId === agentId && Date.now() - hit.at < 60_000) return hit.names;
    const r = await this.request('skills.status', { agentId }, 30_000).catch(() => null);
    const names = (r?.skills || []).map(x => x?.name || x?.skillKey).filter(n => typeof n === 'string' && n);
    this._skillsCache = { agentId, at: Date.now(), names };
    return names;
  }

  /**
   * Existing shares become contacts (once, on the first share list): access kept, a daily cap above 50 → Extended,
   * else Bounded; a real-agent share becomes Full agent (confirmed when it was approved); Knowledge starts as None.
   * Grants are re-issued as v2 so the other side sees the autonomy tier.
   */
  async migrateContacts() {
    const grants = this._localGrants();
    if (!grants.length) return [];
    const agents = await this._agents();
    const known = this.guestAgentIds();
    const made = [];
    for (const r of grants) {
      const s = this._shares.find(x => x.id === r.share_id && x.as === 'owner');
      const person = personKeyOf(s?.requester?.email);
      if (!person) continue;
      let grant; try { grant = JSON.parse(r.grant_json); } catch { continue; }
      if (!this.book.get(person)) {
        const ids = (grant.agents || []).map(a => a.id);
        const real = ids.some(id => { const a = agents.find(x => x.id === id); return a && !isGuestAgent(a, known); });
        const access = real ? 'full' : grant.access === 'trusted' ? 'trusted' : 'restricted';
        this.book.create(person, {
          ...defaultContact(access), knowledge: 'none', migrated: true, name: grant.requesterName || null,
          autonomy: AUTONOMY[grant.autonomy] ? grant.autonomy : autonomyFromCap(grant.dailyCap),
          agents: ids.map(id => this._sourceIdSync(id, agents)), ...(access === 'full' ? { fullConfirmedAt: r.created_at } : {}),
        });
        made.push(person);
      }
      // Signed with a key this gateway no longer has (its peer key was replaced): the same grant is signed again,
      // or the other side, once it trusts the new key, still couldn't verify it.
      const stale = s.status === 'active' && !verifySignature(this.key.publicKey, canonicalJson(grant), r.sig);
      if ((grant.v !== 2 || stale) && s.status === 'active') {
        const c = this.book.get(person);
        try { this.approve(r.share_id, { agents: grant.agents, access: c.access, autonomy: c.autonomy, confirmFull: true }); }
        catch (e) { this.log.warn?.(`[sharing] re-issue ${r.share_id}: ${e.message}`); }
      }
    }
    if (made.length) { this.log.info?.(`[sharing] contacts made from existing shares: ${made.join(', ')}`); this._changed(); }
    return made;
  }

  /** Owner shares with this person that have a grant, newest first. */
  _ownerSharesOf(person) {
    return this._shares.filter(s => s.as === 'owner' && personKeyOf(s.requester?.email) === person && this._grant(s.id));
  }

  /** Everything the contact card shows for a person (Settings → People → name). */
  async contactCard(personKey) {
    const person = personKeyOf(personKey);
    const shares = this._shares.filter(s => this._sharingPerson(s) === person);
    if (!shares.length && !this.book.get(person)) throw Object.assign(new Error('Not a contact'), { code: 'not_found' });
    const c = this.book.get(person);
    const agents = await this._agents();
    const known = this.guestAgentIds();
    const cfg = await this.request('config.get', {}, 30_000).catch(() => null);
    const own = agents.filter(a => !isGuestAgent(a, known));
    const skillNames = await this._skillNames(own.find(a => a.default)?.id || own[0]?.id || 'main');
    const skillInfo = await this.request('skills.status', { agentId: own[0]?.id }, 30_000).then(r => r?.skills || [], () => []);
    const gateways = new Map();
    for (const s of shares) {
      const o = this._other(s);
      if (!o.gatewayId) continue;
      const g = gateways.get(o.gatewayId) || { gatewayId: o.gatewayId, shareIds: [], online: false, theirAgents: [], version: this._peerVersions.get(o.gatewayId) ?? undefined };
      g.shareIds.push(s.id);
      if (s.as === 'requester') g.theirAgents = (this._verifiedGrant(s)?.agents || []).map(a => cleanName(a.name || a.id));
      g.online ||= [...this._links.values(), ...this._served].some(l => l.ready && !l.closed && (l.shareId === s.id));
      gateways.set(o.gatewayId, g);
    }
    // Before Accept there is no contact yet: the first-time form starts from the defaults (Trusted, My notes).
    const view = c || { ...defaultContact('trusted'), personKey: person, agents: null };
    let notes = null;
    {
      const { cands, files } = await this._notePicks(view);
      const picked = new Set(files.map(f => f.src));
      notes = {
        candidates: cands.map(x => ({ path: x.path, name: x.name, size: x.size, mtimeMs: x.mtimeMs, on: picked.has(x.path), defaultOn: x.defaultOn })),
        repoDocs: files.filter(f => !cands.some(x => x.path === f.src)).map(f => ({ path: f.src, name: f.dest.replace(/^repos\//, '') })),
        sync: c?.notesSync ? { files: c.notesSync.files, bytes: c.notesSync.bytes, secretsRemoved: c.notesSync.secretsRemoved, at: c.notesSync.at } : null,
      };
    }
    const u = c ? this.book.usage(person) : { day: 0, hour: 0 };
    return {
      person, contact: c, usage: { ...u, ...(c ? AUTONOMY[c.autonomy] : {}) }, gateways: [...gateways.values()],
      agents: own.map(a => ({ id: a.id, name: a.identity?.name || a.name || a.id })),
      skills: skillNames.map(n => { const i = skillInfo.find(x => (x?.name || x?.skillKey) === n); return { name: n, description: String(i?.description || '').slice(0, 160) }; }),
      mcpServers: Object.keys(cfg?.parsed?.mcp?.servers || {}).sort().map(n => ({ name: n, enabled: cfg.parsed.mcp.servers[n]?.enabled !== false })),
      notes, copies: this.book.copies(person), sessions: this._guestSessionKeysOf(person),
      reviewerModel: reviewerModelFor(cfg?.parsed),
      // What the card draws its controls from (one source with the policy the copies get).
      catalog: { toolGroups: TOOL_GROUPS, alwaysOff: ALWAYS_OFF, basicDefaults: BASIC_DEFAULTS, defaultTools: DEFAULT_TOOLS, defaultCommands: DEFAULT_COMMANDS, autonomy: AUTONOMY, draft: c ? null : { ...view, notes: files0(notes) } },
    };
  }

  /**
   * What the two contact cards between this gateway and a person allow (team.js room limits): `mine` = this side's
   * card for them, `theirs` = their grant to this side. { mine: { access, autonomy } | null, theirs: … | null }.
   */
  limitsFor(gatewayId) {
    const email = this.contact(gatewayId)?.email;
    const c = email ? this.book.get(email) : null;
    const theirs = this._shares.map(s => (s.as === 'requester' && this._ownerGateway(s) === gatewayId ? this._verifiedGrant(s) : null)).find(Boolean);
    return {
      mine: c ? { access: c.access, autonomy: c.autonomy } : null,
      theirs: theirs ? { access: theirs.access, autonomy: AUTONOMY[theirs.autonomy] ? theirs.autonomy : 'bounded' } : null,
    };
  }

  /** The person of a share, either direction. */
  _sharingPerson(s) { return personKeyOf(s.as === 'owner' ? s.requester?.email : s.owner?.email); }

  /**
   * Change one card setting. Access, autonomy and agents re-issue the person's grants; anything a copy holds updates
   * that person's existing copies in the background (new ones are made on first use). Returns the contact.
   */
  async setContact(personKey, field, value, { confirmFull = false } = {}) {
    const person = personKeyOf(personKey);
    const before = this.book.get(person);
    if (!before) throw Object.assign(new Error('Not a contact'), { code: 'not_found' });
    if (field === 'agents') value = (Array.isArray(value) ? value : []).map(String);
    if (field === 'openFolder' && value) value = await this._checkFolder(before, value);
    const c = this.book.set(person, field, value, { confirmFull });
    if (['access', 'autonomy', 'agents'].includes(field)) {
      const names = new Map((await this._agents()).map(a => [a.id, a.identity?.name || a.name || a.id]));
      for (const s of this._ownerSharesOf(person)) {
        const g = this._grant(s.id).grant;
        // Agents keep the id they were shared under (rooms on the other side refer to it).
        const list = (c.agents || []).map(id => g.agents.find(a => this._sourceIdSync(a.id) === id) || { id, name: String(names.get(id) || id).slice(0, 80) });
        this.approve(s.id, { agents: list, access: c.access, autonomy: c.autonomy, confirmFull: true });
      }
    }
    if (field === 'access' && copyKind(before) !== copyKind(c)) this._dropCopies(person, copyKind(before)).catch(e => this.log.warn?.(`[sharing] ${e.message}`));
    this._refreshCopies(person).catch(e => this.log.warn?.(`[sharing] copies for ${person}: ${e.message}`));
    this._changed();
    return c;
  }

  /**
   * "Open one folder" (§12): a real folder inside a shared agent's workspace, never the workspace itself, never one
   * that is or holds secrets/, no links or `..` on the way. Returns its real path.
   */
  async _checkFolder(contact, folder) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const raw = String(folder || '');
    if (!path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) throw new Error('Pick a folder inside your workspace');
    let real; try { real = fs.realpathSync(raw); } catch { throw new Error("That folder doesn't exist"); }
    if (real !== path.normalize(raw).replace(/\/+$/, '')) throw new Error("That path goes through a link; use the folder's real path");
    const roots = (await this._agents()).filter(a => !Array.isArray(contact.agents) || contact.agents.map(id => this._sourceIdSync(id)).includes(a.id)).map(a => a.workspace).filter(Boolean);
    const root = roots.find(r => real.startsWith(`${r.replace(/\/+$/, '')}/`));
    if (!root) throw new Error('Pick a folder inside your workspace, not the workspace itself');
    if (real.split('/').includes('secrets') || fs.existsSync(path.join(real, 'secrets'))) throw new Error('Not secrets/, nor a folder that holds it');
    return real;
  }

  /** Make the person's copies of every agent they can use (after Accept/Save), so their first message doesn't wait on it. */
  prepareCopies(shareId) {
    const person = this._personOfShare(shareId);
    const c = person && this.book.get(person);
    if (!c) return;
    const g = this._grant(shareId)?.grant;
    (async () => {
      for (const a of g?.agents || []) await this._ensureCopy(this.book.get(person), await this._sourceId(a.id), firstName({ name: c.name || person }));
    })().catch(e => this.log.warn?.(`[sharing] copies for ${person}: ${e.message}`));
  }

  /** Bring a person's existing copies up to their card (config write, approvals, notes). */
  async _refreshCopies(person) {
    const c = this.book.get(person);
    if (!c) return;
    const first = firstName({ name: c.name || person });
    for (const r of this.book.copies(person).filter(x => x.kind === copyKind(c))) {
      if (Array.isArray(c.agents) && !c.agents.map(id => this._sourceIdSync(id)).includes(r.agentId)) continue;
      await this._ensureCopy(c, r.agentId, first);
    }
  }

  /** Copies of the other kind after an access change: retired (locked down, kept with their chats), not deleted. */
  async _dropCopies(person, kind) {
    for (const r of this.book.copies(person).filter(x => x.kind === kind)) {
      await retireCopy(this.request, r.copyId);
      this.book.retireCopyRow(r.copyId);
    }
  }

  /** Sync now (card): rewrite every guest copy's notes. Returns the summary. */
  async syncNotesNow(personKey) {
    const c = this.book.get(personKey);
    if (!c) throw Object.assign(new Error('Not a contact'), { code: 'not_found' });
    let summary = null;
    for (const r of this.book.copies(c.personKey).filter(x => x.kind === 'guest')) summary = await this._syncNotesFor(this.book.get(c.personKey), r.copyId, { force: true }) || summary;
    if (!summary && c.knowledge === 'notes') {
      const { files } = await this._notePicks(c);
      summary = { files: files.length, bytes: 0, secretsRemoved: 0, at: null, pending: true }; // copied on their first message
    }
    this._changed();
    return summary;
  }

  /**
   * Disconnect (spec §8.3): their guest sessions are archived, then their copies, approvals entries, notes and every
   * peer_* row for them go. The shares themselves are revoked by the caller (both directions).
   */
  async forgetPerson(personKey) {
    const person = personKeyOf(personKey);
    const keys = this._guestSessionKeysOf(person);
    let archived = 0;
    for (const key of keys) if (await this._archive(key)) archived++;
    // Copies are retired, not deleted: deleting an agent deletes its sessions (2026.11.6), and these chats are kept.
    let retired = 0;
    for (const r of this.book.copies(person).filter(x => !x.kind.startsWith('retired'))) {
      try {
        if (r.kind === 'guest') { const ws = (await this._agents()).find(a => a.id === r.copyId)?.workspace; if (ws?.startsWith('/')) removeNotes(ws); }
        if (await retireCopy(this.request, r.copyId)) retired++;
      } catch (e) { this.log.warn?.(`[sharing] retire ${r.copyId}: ${e.message}`); }
    }
    const db = this._db();
    for (const key of keys) db.prepare('DELETE FROM peer_sessions WHERE session_key = ?').run(key);
    this.book.forget(person);
    this._guestKeys = null;
    this._changed();
    return { archived, retired };
  }

  // ── Peer versions ──────────────────────────────────────────────────

  /** Note a linked gateway's connector version; true when it's too old to share with. */
  _checkPeer(link, gatewayId) {
    const v = link.peerVersion ?? null;
    if (gatewayId && this._peerVersions.get(gatewayId) !== v) { this._peerVersions.set(gatewayId, v); this._changed(); }
    return peerOutdated(v);
  }

  async _guestAbort(shareId, turnId) {
    for (const t of this._turns.values()) if (t.shareId === shareId && turnId && t.clientTurnId === turnId) this._abortTurn(t);
    return { ok: true };
  }

  /**
   * Archive a session. 2026.11.x needs the session id it expects (a lifecycle patch); 9.x has no such field.
   * Returns whether it worked.
   */
  async _archive(key, sessionId = null) {
    const id = sessionId || await this.request('sessions.describe', { key }, 5000).then(r => r?.session?.sessionId || null, () => null);
    const patch = p => this.request('sessions.patch', p).then(() => true);
    return patch({ key, archived: true, ...(id ? { expectedSessionId: id } : {}) })
      .catch(e => (/expectedSessionId|unexpected property|additional/i.test(e.message) && id ? patch({ key, archived: true }) : false))
      .catch(() => false);
  }

  /** The (share, room, agent) session on this gateway: visible to the owner in "Shared with <name>". */
  async _guestSession(shareId, roomId, agentId, { name, roomTitle, permissionMode, toolOverrides, cwd = null }) {
    const db = this._db();
    const row = db.prepare('SELECT session_key FROM peer_sessions WHERE share_id = ? AND room_id = ? AND agent_id = ?').get(shareId, roomId, agentId);
    // The owner may have deleted it from their chat list: then it's made again (same key, so the
    // room keeps pointing at it), in "Shared with <name>" with its label, instead of the gateway
    // bringing it back as an untitled chat that ClawChats hides.
    const described = row && await this.request('sessions.describe', { key: row.session_key }, 5000).then(r => r, () => ({ unknown: true }));
    const exists = row && !(described && 'session' in described && !described.session);
    // A session's root is fixed when it's made. "Open one folder" opened (or moved) after that: the old session (rooted
    // at the whole workspace, secrets/ included) is archived and a new one is made at the folder. Unknown: never reused.
    const root = described?.session?.sessionRoot;
    const wrongRoot = exists && cwd && (described.unknown || !root || root.replace(/\/+$/, '') !== cwd.replace(/\/+$/, ''));
    if (wrongRoot) await this._archive(row.session_key, described?.session?.sessionId);
    if (exists && !wrongRoot) {
      // Re-apply the policy each turn: the owner may have changed the card since. Basic only and Off clear the mode
      // (null): a session mode would override the copy's exec allowlist (spike run 1).
      await this.request('sessions.patch', { key: row.session_key, permissionMode, toolOverrides }).catch(() => {});
      return row.session_key;
    }
    const key = (!wrongRoot && row?.session_key) || `agent:${agentId}:dashboard:${crypto.randomUUID()}`;
    const category = this.funnelOf(this._shares.find(x => x.id === shareId && x.as === 'owner')?.requester?.email, name);
    // Labels are unique per gateway, and untitled rooms all fall back to "team chat": tag each room.
    const tag = crypto.createHash('sha256').update(`${shareId}|${roomId}`).digest('hex').slice(0, 6);
    const create = label => this.request('sessions.create', {
      key, agentId, ...(permissionMode ? { permissionMode } : {}), toolOverrides, label: label.slice(0, 200), category,
      ...(cwd ? { cwd } : {}), // Full agent's "Open one folder": the session root (§12)
    });
    try { await create(`${name} · ${roomTitle} · ${tag}`); }
    catch (e) {
      if (!/label already in use/i.test(e.message)) throw e;
      await create(`${name} · ${roomTitle} · ${tag}-${crypto.randomBytes(2).toString('hex')}`);
    }
    db.prepare('INSERT OR REPLACE INTO peer_sessions (share_id, room_id, agent_id, session_key) VALUES (?, ?, ?, ?)').run(shareId, roomId, agentId, key);
    this._guestKeys = null;
    this._changed(); // the room's list of answering sessions grew: the app needs it before the agent asks for an approval
    return key;
  }

  /** The input sent under `runId` and the reply to it, if that input is in the session: { input, text } (text '' when none), else null. */
  async _replyTo(sessionKey, runId) {
    const h = await this.request('chat.history', { sessionKey, limit: 200 }, 30_000).catch(() => null);
    const msgs = h?.messages || [];
    const at = promptIndex(msgs, runId);
    if (at < 0) return null;
    const reply = replyAfter(msgs, at);
    return { input: await this._fullText(sessionKey, msgs[at]), text: reply ? await this._fullText(sessionKey, reply) : '' };
  }

  /**
   * A turn whose input is in the session but which no run here is following (this connector or its gateway restarted):
   * wait for whatever runs there to finish (on 2026.11.x the gateway resumes a run its restart cut off, under another
   * run id, a few seconds after it's back), then answer with the reply. Stop and "Stop sharing" abort that run.
   */
  async _afterRestart(sessionKey, runId, turn) {
    const started = Date.now();
    const end = started + TURN_TIMEOUT_MS;
    let ran = false;
    for (;;) {
      const s = await this.request('sessions.describe', { key: sessionKey }, 5000).then(r => r?.session || null, () => null);
      if (s?.hasActiveRun) {
        ran = true;
        if (turn.aborted) {
          const ids = Array.isArray(s.activeRunIds) ? s.activeRunIds : [];
          if (ids.length) for (const id of ids) this.chatAbort.abort({ sessionKey, runId: id, sessionId: s.sessionId }).catch(() => {});
          else this.request('chat.abort', { sessionKey }).catch(() => {});
          return { state: 'aborted', text: '' };
        }
      } else {
        if (turn.aborted) return { state: 'aborted', text: '' };
        const r = await this._replyTo(sessionKey, runId);
        if (r?.text) return { state: 'final', text: r.text };
        if (ran || Date.now() - started >= this.recovery.waitMs) break;
      }
      if (Date.now() >= end) break;
      await new Promise(r => setTimeout(r, this.recovery.pollMs));
    }
    throw Object.assign(new Error('The reply was interrupted'), { code: 'run_failed', partial: '' });
  }

  /** A history message's whole text: chat.history caps long ones (`__openclaw.truncated`, ~8 KB); chat.message.get doesn't. */
  async _fullText(sessionKey, m) {
    const text = messageText(m);
    if (!m?.__openclaw?.truncated || !m.__openclaw.id) return text;
    const r = await this.request('chat.message.get', { sessionKey, messageId: m.__openclaw.id, maxChars: 2_000_000 }, 30_000).catch(() => null);
    return (r?.ok && r.message && messageText(r.message)) || text;
  }

  async _lastReply(sessionKey) {
    const h = await this.request('chat.history', { sessionKey, limit: 20 }, 30_000).catch(() => null);
    const msgs = h?.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') return '';
      if (msgs[i].role === 'assistant' && messageText(msgs[i]).trim()) return this._fullText(sessionKey, msgs[i]);
    }
    return '';
  }

  /**
   * Approval events (owner side, from the approval connection): while a guest run waits for this gateway's owner to
   * approve something, the room's host is told, so its room says what it's waiting for instead of only "responding".
   * Only the kind of thing is sent ("a command", or the action's title), never the command itself or its paths.
   */
  onApprovalEvent(msg) {
    const ev = msg?.event || '';
    const m = /^(exec|plugin|openclaw)\.approval\.(requested|resolved)$/.exec(ev);
    if (!m) return;
    const p = msg.payload || {};
    this._approvalRuns ??= new Map(); // approval id -> run id
    if (m[2] === 'requested') {
      const sessionKey = p.request?.sessionKey;
      const entry = sessionKey && [...this._runs.entries()].find(([, r]) => r.sessionKey === sessionKey);
      if (!entry || !p.id) return;
      const [runId, run] = entry;
      this._approvalRuns.set(p.id, runId);
      const what = m[1] === 'exec' ? 'a command' : String(p.request?.title || 'an action').replace(/[\n\r]/g, ' ').slice(0, 80);
      run.waiting = { what, expiresAtMs: Number(p.expiresAtMs) || null };
      run.emit?.('status', { waiting: 'approval', what, expiresAtMs: run.waiting.expiresAtMs });
      return;
    }
    const runId = p.id && this._approvalRuns.get(p.id);
    if (!runId) return;
    this._approvalRuns.delete(p.id);
    const run = this._runs.get(runId);
    if (!run || [...this._approvalRuns.values()].includes(runId)) return; // another approval of this run is still open
    run.waiting = null;
    run.emit?.('status', { waiting: null });
  }

  /** Every gateway event (owner side): finish guest runs, stream their text. */
  onGatewayEvent(msg) {
    if (msg?.event !== 'chat') return;
    const p = msg.payload;
    const run = p?.runId && this._runs.get(p.runId);
    if (!run) return;
    if (p.state === 'delta') {
      if (p.message && !run.text) run.text = messageText(p.message);
      else if (typeof p.deltaText === 'string') run.text = p.replace ? p.deltaText : run.text + p.deltaText;
      run.emit?.('delta', run.text);
      return;
    }
    if (!['final', 'aborted', 'error'].includes(p.state)) return;
    this._runs.delete(p.runId);
    clearTimeout(run.timer);
    run.resolve({ ...p, text: run.text });
  }

  // ── Requester side ─────────────────────────────────────────────────

  /** The grant of a share shared with this gateway, if signed by its (pinned) owner key. */
  _verifiedGrant(s) {
    if (s?.as !== 'requester' || s.status !== 'active' || !s.grant || !s.signature || !s.owner?.pubKey) return null;
    if (this._db().prepare('SELECT 1 FROM peer_removed WHERE share_id = ?').get(s.id)) return null;
    if (s.grant.requesterGatewayId !== this.gatewayId() || s.grant.shareId !== s.id || s.grant.requesterPubKey !== this.key.publicKey) return null;
    // Signed for the gateway the server says it's from: a grant from one contact can't pass as another's.
    if (!s.owner.gatewayId || s.grant.ownerGatewayId !== s.owner.gatewayId) return null;
    const db = this._db();
    const pinRow = db.prepare('SELECT owner_pubkey, owner_gateway_id FROM peer_pins WHERE share_id = ?').get(s.id);
    let pin = pinRow?.owner_pubkey;
    const gwPin = this._gatewayKey(s.owner.gatewayId);
    // The owner already trusted this gateway's new key (trustNewKey): a share's older pin follows it.
    if (pin && gwPin && pin !== gwPin && gwPin === s.owner.pubKey) {
      db.prepare('UPDATE peer_pins SET owner_pubkey = ? WHERE share_id = ?').run(gwPin, s.id);
      pin = gwPin;
    }
    if ((pin && pin !== s.owner.pubKey) || (gwPin && gwPin !== s.owner.pubKey)) {
      const was = pin && pin !== s.owner.pubKey ? pin : gwPin;
      if (!(this._warnedKeys ??= new Set()).has(`${s.id}|${s.owner.pubKey}`)) {
        this._warnedKeys.add(`${s.id}|${s.owner.pubKey}`);
        this.log.warn?.(`[sharing] owner key changed for ${s.id} (was ${fingerprint(was)}, now ${fingerprint(s.owner.pubKey)}): refusing`);
      }
      return null;
    }
    if (!verifySignature(s.owner.pubKey, canonicalJson(s.grant), s.signature)) return null;
    if (!pin) db.prepare('INSERT OR IGNORE INTO peer_pins (share_id, owner_pubkey, created_at, owner_gateway_id) VALUES (?, ?, ?, ?)').run(s.id, s.owner.pubKey, Date.now(), s.owner.gatewayId);
    else if (!pinRow.owner_gateway_id) db.prepare('UPDATE peer_pins SET owner_gateway_id = ? WHERE share_id = ?').run(s.owner.gatewayId, s.id);
    if (!gwPin) this._pinGatewayKey(s.owner.gatewayId, s.owner.pubKey);
    return s.grant;
  }

  /** Agents shared with this gateway: [{ agentId: 'peer:<share>:<agent>', name, ownerName, shareId }]. */
  remoteAgents() {
    const out = [];
    for (const s of this._shares) {
      const grant = this._verifiedGrant(s);
      if (!grant) continue;
      const owner = this.labelOf(s.owner?.gatewayId, s.owner?.name || s.owner?.email) || firstName(s.owner);
      for (const a of grant.agents) {
        if (typeof a?.id !== 'string' || !a.id || a.id.length > 100) continue;
        out.push({ agentId: `peer:${s.id}:${a.id}`, name: `${cleanName(a.name || a.id) || 'Agent'} · ${owner}`, ownerName: owner, shareId: s.id, remoteId: a.id });
      }
    }
    return out;
  }

  static parseRemoteId(agentId) {
    const m = /^peer:([^:]+):(.+)$/.exec(String(agentId || ''));
    return m ? { shareId: m[1], remoteId: m[2] } : null;
  }

  async _link(shareId) {
    const cur = this._links.get(shareId);
    if (cur?.ready && !cur.closed) return cur;
    if (this._linking.has(shareId)) return this._linking.get(shareId);
    const s = this._shares.find(x => x.id === shareId);
    const grant = this._verifiedGrant(s);
    if (!grant) throw Object.assign(new Error('This share is not active'), { code: 'revoked' });
    const p = (async () => {
      const { dc, dtls } = await this.openPeer(shareId);
      const link = new PeerLink({ dc, dtls, role: 'requester', shareId, key: this.key, peerKey: s.owner.pubKey, log: this.log, version: this.version });
      await new Promise((resolve, reject) => { link.once('ready', resolve); link.once('closed', () => reject(new Error(`Couldn't reach ${firstName(s.owner)}'s gateway`))); });
      if (this._checkPeer(link, grant.ownerGatewayId)) {
        link.close();
        throw Object.assign(new Error(outdatedMessage(firstName(s.owner), link.peerVersion)), { code: 'peer_outdated' });
      }
      this._links.set(shareId, link);
      link.on('closed', () => { if (this._links.get(shareId) === link) this._links.delete(shareId); });
      this._wireRooms(link, grant.ownerGatewayId); // the gateway the key this link authenticated signed for
      return link;
    })().finally(() => this._linking.delete(shareId));
    this._linking.set(shareId, p);
    return p;
  }

  /**
   * Run a turn on a shared agent. Returns { state, text }; throws with `.partial` on failure.
   * A link that drops mid-turn is dialled again and the identical request sent again (at most twice, within the
   * turn's timeout): the owner attaches it to the run still going there, or answers from the finished one, so the
   * turn never runs twice. `stopped()`: the room was stopped, so it isn't sent again.
   */
  async turn(agentId, { turnId, roomId, roomTitle, message, trigger = 'person', round = 0 }, { onDelta, onStatus, stopped = () => false } = {}) {
    const id = SharingManager.parseRemoteId(agentId);
    if (!id) throw new Error('not a shared agent');
    // trigger/round: what started this turn (a person's message, or another agent's reply in round N), for the
    // owner's autonomy tier.
    const params = { turnId, agentId: id.remoteId, roomId, roomTitle, message, trigger, round };
    const onEvent = (event, data) => {
      if (event === 'delta' && typeof data === 'string') onDelta?.(data);
      else if (event === 'status' && data && typeof data === 'object') onStatus?.(data);
    };
    const deadline = Date.now() + APPROVAL_TURN_TIMEOUT_MS + 60_000; // the owner ends the turn sooner when it can't ask
    for (let resend = 0; ; resend++) {
      try {
        const link = await this._link(id.shareId);
        const s = this._shares.find(x => x.id === id.shareId);
        if (this._checkPeer(link, this._ownerGateway(s))) throw Object.assign(new Error(outdatedMessage(firstName(s?.owner), link.peerVersion)), { code: 'peer_outdated' });
        return await link.request('turn', params, { onEvent, timeoutMs: deadline - Date.now() });
      } catch (e) {
        // Only a dropped link (or, while resending, the link not back yet): local errors, without a code. Never
        // something the other side answered (refused, cap, revoked...): those always carry one.
        const dropped = !e.code && (e.message === 'peer link closed' || resend > 0);
        const wait = this.resendBackoffMs[resend];
        if (!dropped || !turnId || wait === undefined || stopped() || Date.now() + wait >= deadline) throw e;
        this.log.info?.(`[sharing] turn ${turnId}: link to ${id.shareId} dropped, sending it again in ${wait / 1000} s`);
        await new Promise(r => setTimeout(r, wait));
        if (stopped()) throw e;
      }
    }
  }

  // ── Acting for someone else (team chats on this gateway) ──────────

  /**
   * Who another person's agent belongs to, as this gateway's owner-side grant to that person: the
   * active share where they asked for this gateway's agents, matched by their gateway (else email).
   * Returns { shareId, grant } or null when this gateway shares nothing with them.
   */
  _grantToOwnerOf(who) {
    // `who`: another person's agent ('peer:<share>:<agent>') or a person ('person:<gateway id>').
    let gw, email;
    if (String(who || '').startsWith('person:')) {
      gw = who.slice('person:'.length);
      email = String(this.contact(gw)?.email || '').toLowerCase();
    } else {
      const id = SharingManager.parseRemoteId(who);
      const theirs = id && this._shares.find(s => s.id === id.shareId && s.as === 'requester');
      if (!theirs) return null;
      gw = this._ownerGateway(theirs); email = String(theirs.owner?.email || '').toLowerCase();
    }
    const candidates = this._shares.filter(s => s.as === 'owner' && s.status === 'active');
    const mine = candidates.find(s => gw && this._other(s).gatewayId === gw)
      || candidates.find(s => email && String(s.requester?.email || '').toLowerCase() === email);
    const g = mine && this._grant(mine.id);
    return g ? { shareId: mine.id, grant: g.grant } : null;
  }

  /** The name to show for whom a local agent acts ("Kamil"), or null. */
  actingForName(remoteAgentId) {
    const g = this._grantToOwnerOf(remoteAgentId);
    return g ? (firstName({ name: g.grant.requesterName }) || 'Someone') : null;
  }

  /**
   * Shared agents renamed since they were approved ("main" -> "homiabot"): re-issue those grants with
   * the new names, same agents, access and cap, so the people they're shared with see the new name.
   * A guest version is shown under its original's name, as when it was approved. Runs on a timer (index.js).
   */
  async syncAgentNames() {
    const grants = this._localGrants();
    if (!grants.length) return [];
    const agents = (await this.request('agents.list', {}))?.agents || [];
    const label = a => a?.identity?.name || a?.name || a?.id;
    const shown = id => {
      const a = agents.find(x => x.id === id);
      if (!a) return null;
      const known = this.guestAgentIds();
      if (!isGuestAgent(a, known)) return label(a);
      const src = agents.find(o => o.id !== id && findGuestAgent(agents, o.id, known)?.id === id);
      return src ? label(src) : null;
    };
    const reissued = [];
    for (const r of grants) {
      const grant = JSON.parse(r.grant_json);
      const live = this._shares.find(x => x.id === r.share_id && x.as === 'owner' && x.status === 'active');
      if (!live || !Array.isArray(grant.agents)) continue;
      const next = grant.agents.map(a => ({ id: a.id, name: String(shown(a.id) || a.name).slice(0, 80) }));
      if (next.every((a, i) => a.name === grant.agents[i].name)) continue;
      try { this.approve(r.share_id, { agents: next, access: grant.access, autonomy: grant.autonomy, dailyCap: grant.autonomy ? null : grant.dailyCap, confirmFull: true }); reissued.push(r.share_id); }
      catch (e) { this.log?.warn?.(`[sharing] rename ${r.share_id}: ${e.message}`); }
    }
    return reissued;
  }

  // ── Funnel: the project one person's chats go to ───────────────────
  // Set when the person is added (invite or accept) and changeable in Settings → People. It covers
  // both what they host (our copies of their chats) and our agents' guest sessions for them. Stored by
  // name; ClawChats renames follow it (renameFunnel), a deleted project is made again by the next chat.
  // Keyed by the person's email: known from the invite on, before any gateway id.

  funnelOf(email, name) {
    const row = email && this._db().prepare('SELECT project FROM peer_funnel WHERE email = ?').get(String(email).toLowerCase());
    return row?.project || `Shared with ${cleanName(name, 60) || 'someone'}`.slice(0, 100);
  }

  funnels() {
    return Object.fromEntries(this._db().prepare('SELECT email, project FROM peer_funnel').all().map(r => [r.email, r.project]));
  }

  /** Where this person's chats go from now on, and move the ones already here. Returns how many moved. */
  async setFunnel(email, project) {
    const e = String(email || '').toLowerCase().trim();
    const name = cleanName(project, 100);
    if (!e || !name) throw new Error('email and project are required');
    this._db().prepare('INSERT INTO peer_funnel (email, project, updated_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET project = excluded.project, updated_at = excluded.updated_at').run(e, name, Date.now());
    let moved = 0;
    for (const key of this._guestSessionKeysOf(e)) {
      if (await this.request('sessions.patch', { key, category: name }).then(() => true, () => false)) moved++;
    }
    moved += (await this.onFunnelChanged?.(e, name)) || 0; // copies of their chats (team.js)
    this._changed();
    return { moved };
  }

  /** A project was renamed in ClawChats: whoever is funnelled there follows. */
  renameFunnel(from, to) {
    if (!from || !to || from === to) return 0;
    return this._db().prepare('UPDATE peer_funnel SET project = ?, updated_at = ? WHERE project = ?').run(String(to).slice(0, 100), Date.now(), from).changes;
  }

  /** Every gateway this person has been on, across shares of any age (old ones were ended and replaced). */
  gatewayIdsOf(email) {
    const ids = new Set();
    for (const s of this._shares) {
      const o = s.as === 'owner' ? s.requester : s.owner;
      if (String(o?.email || '').toLowerCase() === email && o.gatewayId) ids.add(o.gatewayId);
    }
    return ids;
  }

  /** Our agents' guest sessions for this person, including ones from shares since ended (and their own copies' sessions). */
  _guestSessionKeysOf(email) {
    const ids = this.gatewayIdsOf(email);
    const copies = new Set(this.book.copies(email).map(c => c.copyId));
    const keys = new Set();
    for (const r of this._db().prepare('SELECT p.session_key, p.agent_id, g.grant_json FROM peer_sessions p LEFT JOIN peer_grants g ON g.share_id = p.share_id').all()) {
      if (copies.has(r.agent_id)) { keys.add(r.session_key); continue; }
      let gw; try { gw = JSON.parse(r.grant_json).requesterGatewayId; } catch { continue; }
      if (ids.has(gw)) keys.add(r.session_key);
    }
    return [...keys];
  }

  /** The guest session that answers `who` in a team chat here (TeamCoordinator lanes): one per share, like _guestSession. */
  laneFor(who) {
    const g = this._grantToOwnerOf(who);
    return g ? `guest:${g.shareId}` : null;
  }

  /**
   * Run one of this gateway's agents because another person's agent asked (a team chat here):
   * authority comes from who asked (specs/sharing-people.md), so it runs as the version shared with
   * that person (its guest copy, normally) under their grant: access level, daily cap, its own
   * session in "Shared with <name>". Returns null when that agent isn't shared with them.
   */
  async localTurnFor(localAgentId, remoteAgentId, { turnId, roomId, roomTitle, message, round = 0 }, { onDelta } = {}) {
    const g = this._grantToOwnerOf(remoteAgentId);
    if (!g) return null;
    const agents = (await this.request('agents.list', {}))?.agents || [];
    const guestId = findGuestAgent(agents, localAgentId, this.guestAgentIds())?.id;
    const shared = g.grant.agents.find(a => a.id === guestId) || g.grant.agents.find(a => a.id === localAgentId);
    if (!shared) return null;
    const byPerson = String(remoteAgentId).startsWith('person:');
    // Their gateway is too old to share with: nothing runs for them here either.
    const gw = byPerson ? remoteAgentId.slice('person:'.length) : this.ownerOf(remoteAgentId);
    if (gw && this._peerVersions.has(gw) && peerOutdated(this._peerVersions.get(gw))) throw Object.assign(new Error(outdatedMessage(firstName({ name: g.grant.requesterName }), this._peerVersions.get(gw))), { code: 'peer_outdated' });
    return this._guestTurn(g.shareId, { turnId, agentId: shared.id, roomId, roomTitle, message, inOwnerRoom: true, byPerson, trigger: byPerson ? 'person' : 'agent', round },
      (event, data) => { if (event === 'delta' && typeof data === 'string') onDelta?.(data); });
  }

  async abortLocalFor(localAgentId, remoteAgentId, turnId) {
    const g = this._grantToOwnerOf(remoteAgentId);
    if (g) await this._guestAbort(g.shareId, turnId);
  }

  async abort(agentId, turnId) {
    const id = SharingManager.parseRemoteId(agentId);
    const link = id && this._links.get(id.shareId);
    if (link?.ready) await link.request('abort', { turnId }, { timeoutMs: 10_000 }).catch(() => {});
  }

  close() {
    this._closed = true;
    clearTimeout(this._presenceTimer);
    for (const l of this._links.values()) l.close();
    for (const l of this._served) l.close();
    this._links.clear();
  }
}
