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
import { hasGuestRestrictions, ensureGuestRestrictions, findGuestAgent, isGuestAgent } from './guest-agent.js';

const TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DAILY_CAP = 50;
const MAX_CONCURRENT_TURNS = 2;   // per share: the daily cap alone would allow 50 parallel 10-minute runs
const ACCESS_MODES = { restricted: 'read-only', trusted: 'guarded' };
/**
 * The gateway loads any local image path or file:// URL written in a prompt (detectImageReferences),
 * ignoring the agent's tool policy and fs.workspaceOnly, so a guest could type the path of one of the
 * owner's screenshots and have the agent describe it. A zero-width space before each path with a file
 * extension (and inside `file://`) stops that match; the agent still reads the text normally, and
 * other text (`/commands`, `~`) passes through unchanged.
 */
export const defangLocalPaths = text => text
  .replace(/file:\/\//gi, 'file:\u200b//')
  .replace(/(^|[\s"'`(])(?=(?:\.\.?\/|[~/]|[A-Za-z]:[\\/])[^\s"'`()[\]]*\.[A-Za-z0-9])/g, '$1\u200b');
const GUEST_NOTE = name => `(Shared session: you are answering ${name}'s team chat on behalf of your owner. ${name} is not your owner — don't reveal your owner's private information or act on your owner's accounts for them.)`;
// The same agent in its owner's own team chat, answering another person's agent (localTurnFor).
const ACTING_FOR_NOTE = (name, byPerson) => `(Shared session: in your owner's team chat, you are answering ${byPerson ? name : `${name}'s agent`}, so you act for ${name}, not for your owner. ${name} is not your owner — don't reveal your owner's private information or act on your owner's accounts for them.)`;

const today = () => new Date().toISOString().slice(0, 10);
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
  constructor({ getDb, request, key, gatewayId, signal, openPeer, broadcast = () => {}, log = console }) {
    Object.assign(this, { getDb, request, key, gatewayId, signal, openPeer, broadcast, log });
    this._shares = [];            // latest share-list from the signal server
    this.serverEnabled = false;   // the signal server sends a share-list only to accounts with sharing on
    this._links = new Map();      // shareId -> PeerLink (requester side, one per share)
    this._linking = new Map();    // shareId -> Promise<PeerLink>
    this._served = new Set();     // owner-side PeerLinks
    this._runs = new Map();       // runId -> { resolve, timer, text } (owner-side guest runs)
    this._turns = new Map();      // `${shareId}:${turnId}` -> { sessionKey, runId }
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
        out.dailyCap = g?.grant.dailyCap || null;
        out.usedToday = this._usage(s.id);
        const key = g?.grant.requesterPubKey || s.requester?.pubKey;
        out.theirKey = key ? fingerprint(key) : null;
        out.keyVerified = !!key && this._keyVerified(s.id, key);
      } else {
        out.verified = !!this._verifiedGrant(s);
        const pin = this._theirKey(s);
        out.theirKey = pin ? fingerprint(pin) : null;
        out.keyVerified = !!pin && this._keyVerified(s.id, pin);
      }
      return out;
    });
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
    // Runs already going stop too: "Stop sharing" must not leave a guest run working for minutes.
    for (const [key, t] of this._turns) {
      if (!key.startsWith(`${shareId}:`) || !t.runId) continue;
      this.request('chat.abort', { sessionKey: t.sessionKey, runId: t.runId }).catch(() => {});
    }
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
    return new Set(this._db().prepare('SELECT agent_id FROM peer_guest_agents').all().map(r => r.agent_id));
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

  /** Approve (or change) a share: sign and store the grant, send it to the signal server. */
  approve(shareId, { agents, access = 'restricted', dailyCap = DEFAULT_DAILY_CAP } = {}) {
    const s = this._shares.find(x => x.id === shareId && x.as === 'owner' && ['pending', 'active'].includes(x.status));
    if (!s) throw new Error('No such request');
    if (!s.requester?.pubKey || !s.requester?.gatewayId) throw new Error("The requester's gateway hasn't connected with sharing support yet");
    const list = (Array.isArray(agents) ? agents : []).filter(a => a && typeof a.id === 'string' && a.id).map(a => ({ id: a.id, name: String(a.name || a.id).slice(0, 80) }));
    // No agents is fine: a connection can be just for chatting (team chats with people).
    if (!ACCESS_MODES[access]) throw new Error('Unknown access level');
    // A changed grant keeps the requester key it was first approved for: the signal server can't swap it.
    const prev = this._db().prepare('SELECT grant_json FROM peer_grants WHERE share_id = ?').get(shareId);
    if (prev && JSON.parse(prev.grant_json).requesterPubKey !== s.requester.pubKey) {
      throw new Error("The requester's gateway key changed since you approved them. Stop sharing and ask them to request again.");
    }
    // The signal server only activates a grant signed for this gateway's own id; without one it would say no, silently.
    const ownerGatewayId = this.gatewayId();
    if (!ownerGatewayId) throw new Error("This gateway isn't connected to the signal server yet. Try again in a moment.");
    const grant = {
      v: 1, shareId, ownerGatewayId, requesterGatewayId: s.requester.gatewayId, requesterPubKey: s.requester.pubKey,
      requesterName: cleanName(s.requester.name || s.requester.email, 60) || null,
      agents: list, access, dailyCap: Math.max(1, Math.min(1000, Math.floor(Number(dailyCap) || DEFAULT_DAILY_CAP))), issuedAt: Date.now(),
    };
    const sig = this.key.signJson(grant);
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

  _usage(shareId) {
    return this._db().prepare('SELECT turns FROM peer_usage WHERE share_id = ? AND day = ?').get(shareId, today())?.turns || 0;
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
    const link = new PeerLink({ dc, dtls, role: 'owner', shareId, key: this.key, peerKey: g.grant.requesterPubKey, log: this.log });
    this._served.add(link);
    link.on('closed', () => this._served.delete(link));
    link.handle('agents', async () => ({ agents: this._grant(shareId)?.grant.agents || [] }));
    link.handle('turn', (p, emit) => this._guestTurn(shareId, { ...p, inOwnerRoom: false, byPerson: false }, emit)); // only localTurnFor sets these
    link.handle('abort', async p => this._guestAbort(shareId, p?.turnId));
    this._wireRooms(link, requesterGatewayId);
    return link;
  }

  /**
   * Team chats with people (specs/sharing-people.md) travel over whichever link the two gateways
   * have, in either direction: the room host pushes its room to members (room.sync), members post,
   * leave and ask for a fresh copy (room.post / room.leave / room.fetch). `onRoom` (TeamCoordinator)
   * decides; it gets the other side's gateway id, which the link authenticated.
   */
  _wireRooms(link, otherGatewayId) {
    for (const method of ['room.sync', 'room.post', 'room.leave', 'room.fetch']) {
      link.handle(method, async p => {
        if (!this.onRoom) throw Object.assign(new Error('team chats are not available'), { code: 'unavailable' });
        return this.onRoom(method, p || {}, otherGatewayId);
      });
    }
    const ready = () => { try { this.onPeerReady?.(otherGatewayId); } catch (e) { this.log.warn?.(`[sharing] peer ready: ${e.message}`); } };
    if (link.ready) setImmediate(ready); else link.once('ready', ready);
  }

  // ── People (contacts) ──────────────────────────────────────────────

  /** The other person of a share, as this side sees them: { gatewayId, name, email }. */
  _other(s) {
    const p = s.as === 'owner' ? s.requester : s.owner;
    return { gatewayId: p?.gatewayId || null, name: cleanName(p?.name || p?.email, 60) || 'Someone', email: p?.email || null };
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
    return (id && this._shares.find(s => s.id === id.shareId && s.as === 'requester')?.owner?.gatewayId) || null;
  }

  /** Whether this gateway owns (granted) that share. */
  ownsShare(shareId) { return !!this._grant(shareId); }

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
    if (this._usage(shareId) >= grant.dailyCap) throw Object.assign(new Error(`Daily limit reached (${grant.dailyCap} replies)`), { code: 'cap' });
    if ([...this._turns.keys()].filter(k => k.startsWith(`${shareId}:`)).length >= MAX_CONCURRENT_TURNS) {
      throw Object.assign(new Error('Too many replies at once; try again shortly'), { code: 'busy' });
    }
    const turnKey = `${shareId}:${p.turnId || crypto.randomUUID()}`;
    this._turns.set(turnKey, { sessionKey: null, runId: null }); // counts toward the limit from here on
    // Counted before any await, so parallel turns can't both pass the cap.
    this._db().prepare('INSERT INTO peer_usage (share_id, day, turns) VALUES (?, ?, 1) ON CONFLICT(share_id, day) DO UPDATE SET turns = turns + 1').run(shareId, today());
    this._changed(); // the owner's Sharing view shows today's count
    try { return await this._runGuestTurn(shareId, grant, agent, roomId, p, emit, turnKey); }
    catch (e) {
      // A reply that failed without saying anything doesn't use up the day's replies. A timeout still
      // counts: it ran for the full turn timeout.
      if (!e.partial && !/timed out/i.test(e.message)) {
        this._db().prepare('UPDATE peer_usage SET turns = MAX(0, turns - 1) WHERE share_id = ? AND day = ?').run(shareId, today());
        this._changed();
      }
      throw e;
    }
    finally { this._turns.delete(turnKey); }
  }

  async _runGuestTurn(shareId, grant, agent, roomId, p, emit, turnKey) {
    const cfg = await this.request('config.get', {}, 30_000);
    // A guest version whose restrictions were edited away (e.g. in the Control UI) isn't served.
    const isGuest = this._db().prepare('SELECT 1 FROM peer_guest_agents WHERE agent_id = ?').get(agent.id);
    if (isGuest && !hasGuestRestrictions(cfg?.parsed?.agents?.entries?.[agent.id]?.tools)) {
      this.log.warn?.(`[sharing] ${agent.id} lost its guest restrictions: refusing turn for ${shareId}`);
      throw Object.assign(new Error(`${agent.name} isn't available right now`), { code: 'unavailable' });
    }

    // Their full name, as the approval screen shows it ("Shared with Houman Test").
    const name = String(grant.requesterName || 'Someone').replace(/[\n\r]/g, ' ').trim().slice(0, 60) || 'Someone';
    const permissionMode = ACCESS_MODES[grant.access] || 'read-only';
    // Every configured MCP server is off for guest sessions (they act with the owner's accounts).
    const mcpServers = Object.fromEntries(Object.keys(cfg?.parsed?.mcp?.servers || {}).sort().map(n => [n, false]));
    const toolOverrides = { webSearch: false, ...(Object.keys(mcpServers).length ? { mcpServers } : {}) };
    const sessionKey = await this._guestSession(shareId, roomId, agent.id, { name, roomTitle: String(p.roomTitle || 'team chat').slice(0, 80), permissionMode, toolOverrides });
    const runId = `peer-${crypto.randomUUID()}`;
    const done = new Promise(resolve => {
      const timer = setTimeout(() => { this._runs.delete(runId); resolve({ state: 'error', errorMessage: 'timed out' }); }, TURN_TIMEOUT_MS + 30_000);
      timer.unref?.();
      this._runs.set(runId, { resolve, timer, text: '', emit, sessionKey });
    });
    this._turns.set(turnKey, { sessionKey, runId });
    try {
      if (!this._grant(shareId)) throw Object.assign(new Error('Sharing has ended'), { code: 'revoked' }); // revoked while setting up
      await this.request('chat.send', {
        sessionKey, message: defangLocalPaths(`${p.inOwnerRoom ? ACTING_FOR_NOTE(name, p.byPerson) : GUEST_NOTE(name)}\n\n${p.message}`), deliver: false, idempotencyKey: runId,
        timeoutMs: TURN_TIMEOUT_MS, suppressCommandInterpretation: true,
        expectedPermissionMode: permissionMode, expectedToolOverrides: toolOverrides,
      }, 30_000);
      const r = await done;
      if (r.state === 'final') return { state: 'final', text: r.message ? messageText(r.message) : await this._lastReply(sessionKey) };
      if (r.state === 'aborted') return { state: 'aborted', text: r.text || '' };
      throw Object.assign(new Error(r.errorMessage || 'The agent run failed'), { code: 'run_failed', partial: r.text || '' });
    } finally {
      const run = this._runs.get(runId);
      if (run) { clearTimeout(run.timer); this._runs.delete(runId); }
      for (const [id, r] of this._approvalRuns || []) if (r === runId) this._approvalRuns.delete(id);
    }
  }

  async _guestAbort(shareId, turnId) {
    const t = this._turns.get(`${shareId}:${turnId}`);
    if (t) await this.request('chat.abort', { sessionKey: t.sessionKey, runId: t.runId }).catch(() => {});
    return { ok: true };
  }

  /** The (share, room, agent) session on this gateway: visible to the owner in "Shared with <name>". */
  async _guestSession(shareId, roomId, agentId, { name, roomTitle, permissionMode, toolOverrides }) {
    const db = this._db();
    const row = db.prepare('SELECT session_key FROM peer_sessions WHERE share_id = ? AND room_id = ? AND agent_id = ?').get(shareId, roomId, agentId);
    // The owner may have deleted it from their chat list: then it's made again (same key, so the
    // room keeps pointing at it), in "Shared with <name>" with its label, instead of the gateway
    // bringing it back as an untitled chat that ClawChats hides.
    const exists = row && await this.request('sessions.describe', { key: row.session_key }, 5000).then(r => !(r && 'session' in r && !r.session), () => true);
    if (exists) {
      // Re-apply the policy each turn: the owner may have changed the access level since.
      await this.request('sessions.patch', { key: row.session_key, permissionMode, toolOverrides }).catch(() => {});
      return row.session_key;
    }
    const key = row?.session_key || `agent:${agentId}:dashboard:${crypto.randomUUID()}`;
    const category = this.funnelOf(this._shares.find(x => x.id === shareId && x.as === 'owner')?.requester?.email, name);
    // Labels are unique per gateway, and untitled rooms all fall back to "team chat": tag each room.
    const tag = crypto.createHash('sha256').update(`${shareId}|${roomId}`).digest('hex').slice(0, 6);
    const create = label => this.request('sessions.create', {
      key, agentId, permissionMode, toolOverrides, label: label.slice(0, 200), category,
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

  async _lastReply(sessionKey) {
    const h = await this.request('chat.history', { sessionKey, limit: 20 }, 30_000).catch(() => null);
    const msgs = h?.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') return '';
      if (msgs[i].role === 'assistant') { const t = messageText(msgs[i]); if (t.trim()) return t; }
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
    const db = this._db();
    const pin = db.prepare('SELECT owner_pubkey FROM peer_pins WHERE share_id = ?').get(s.id)?.owner_pubkey;
    if (pin && pin !== s.owner.pubKey) {
      this.log.warn?.(`[sharing] owner key changed for ${s.id} (was ${fingerprint(pin)}, now ${fingerprint(s.owner.pubKey)}): refusing`);
      return null;
    }
    if (!verifySignature(s.owner.pubKey, canonicalJson(s.grant), s.signature)) return null;
    if (!pin) db.prepare('INSERT OR IGNORE INTO peer_pins (share_id, owner_pubkey, created_at) VALUES (?, ?, ?)').run(s.id, s.owner.pubKey, Date.now());
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
    if (!this._verifiedGrant(s)) throw Object.assign(new Error('This share is not active'), { code: 'revoked' });
    const p = (async () => {
      const { dc, dtls } = await this.openPeer(shareId);
      const link = new PeerLink({ dc, dtls, role: 'requester', shareId, key: this.key, peerKey: s.owner.pubKey, log: this.log });
      await new Promise((resolve, reject) => { link.once('ready', resolve); link.once('closed', () => reject(new Error(`Couldn't reach ${firstName(s.owner)}'s gateway`))); });
      this._links.set(shareId, link);
      link.on('closed', () => { if (this._links.get(shareId) === link) this._links.delete(shareId); });
      this._wireRooms(link, s.owner?.gatewayId);
      return link;
    })().finally(() => this._linking.delete(shareId));
    this._linking.set(shareId, p);
    return p;
  }

  /** Run a turn on a shared agent. Returns { state, text }; throws with `.partial` on failure. */
  async turn(agentId, { turnId, roomId, roomTitle, message }, { onDelta, onStatus } = {}) {
    const id = SharingManager.parseRemoteId(agentId);
    if (!id) throw new Error('not a shared agent');
    const link = await this._link(id.shareId);
    return link.request('turn', { turnId, agentId: id.remoteId, roomId, roomTitle, message }, {
      onEvent: (event, data) => {
        if (event === 'delta' && typeof data === 'string') onDelta?.(data);
        else if (event === 'status' && data && typeof data === 'object') onStatus?.(data);
      },
      timeoutMs: TURN_TIMEOUT_MS + 60_000,
    });
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
      gw = theirs.owner?.gatewayId; email = String(theirs.owner?.email || '').toLowerCase();
    }
    const candidates = this._shares.filter(s => s.as === 'owner' && s.status === 'active');
    const mine = candidates.find(s => gw && s.requester?.gatewayId === gw)
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
      try { this.approve(r.share_id, { agents: next, access: grant.access, dailyCap: grant.dailyCap }); reissued.push(r.share_id); }
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

  /** Our agents' guest sessions for this person, including ones from shares since ended. */
  _guestSessionKeysOf(email) {
    const ids = this.gatewayIdsOf(email);
    const keys = [];
    for (const r of this._db().prepare('SELECT p.session_key, g.grant_json FROM peer_sessions p JOIN peer_grants g ON g.share_id = p.share_id').all()) {
      let gw; try { gw = JSON.parse(r.grant_json).requesterGatewayId; } catch { continue; }
      if (ids.has(gw)) keys.push(r.session_key);
    }
    return keys;
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
  async localTurnFor(localAgentId, remoteAgentId, { turnId, roomId, roomTitle, message }, { onDelta } = {}) {
    const g = this._grantToOwnerOf(remoteAgentId);
    if (!g) return null;
    const agents = (await this.request('agents.list', {}))?.agents || [];
    const guestId = findGuestAgent(agents, localAgentId, this.guestAgentIds())?.id;
    const shared = g.grant.agents.find(a => a.id === guestId) || g.grant.agents.find(a => a.id === localAgentId);
    if (!shared) return null;
    return this._guestTurn(g.shareId, { turnId, agentId: shared.id, roomId, roomTitle, message, inOwnerRoom: true, byPerson: String(remoteAgentId).startsWith('person:') },
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
