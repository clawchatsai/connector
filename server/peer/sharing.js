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

const TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DAILY_CAP = 50;
const ACCESS_MODES = { restricted: 'read-only', trusted: 'guarded' };
const GUEST_NOTE = name => `(Shared session: you are answering ${name}'s team chat on behalf of your owner. ${name} is not your owner — don't reveal your owner's private information or act on your owner's accounts for them.)`;

const today = () => new Date().toISOString().slice(0, 10);
const firstName = p => String(p?.name || p?.email || 'Someone').split(/[\s@]/)[0];

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
      g.exec(`CREATE TABLE IF NOT EXISTS peer_pins (share_id TEXT PRIMARY KEY, owner_pubkey TEXT NOT NULL, created_at INTEGER NOT NULL)`);
      g.exec(`CREATE TABLE IF NOT EXISTS peer_sessions (share_id TEXT NOT NULL, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_key TEXT NOT NULL, PRIMARY KEY (share_id, room_id, agent_id))`);
      g.exec(`CREATE TABLE IF NOT EXISTS peer_usage (share_id TEXT NOT NULL, day TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (share_id, day))`);
      this._ready = true;
    }
    return g;
  }

  // ── Share list (signal server) ─────────────────────────────────────

  /** `share-list` from the signal server. Ends links/grants for shares that are gone. */
  setShares(shares) {
    this.serverEnabled = true;
    this._shares = Array.isArray(shares) ? shares : [];
    const live = new Set(this._shares.filter(s => s.status === 'active').map(s => s.id));
    for (const [shareId, link] of this._links) if (!live.has(shareId)) { link.close(); this._links.delete(shareId); }
    for (const s of this._localGrants()) if (!live.has(s.share_id) && !this._shares.some(x => x.id === s.share_id && x.status === 'pending')) this._revokeLocal(s.share_id);
    this._changed();
  }

  /** The signal server says a share ended (revoke/decline): stop at once. */
  onShareRevoked(shareId) {
    this._revokeLocal(shareId);
    this._links.get(shareId)?.close();
    this._links.delete(shareId);
    this._changed();
  }

  _changed() { this.broadcast(JSON.stringify({ type: 'clawchats', event: 'sharing-changed' })); }

  /** Shares for the ClawChats UI, with what this side has verified. */
  list() {
    return this._shares.map(s => {
      const out = { id: s.id, as: s.as, status: s.status, createdAt: s.createdAt, requester: s.requester, owner: s.owner, agents: s.agents || [] };
      if (s.as === 'owner') {
        const g = this._grant(s.id);
        out.access = g?.grant.access || null;
        out.dailyCap = g?.grant.dailyCap || null;
        out.usedToday = this._usage(s.id);
      } else {
        out.verified = !!this._verifiedGrant(s);
      }
      return out;
    });
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
  }

  /** Approve (or change) a share: sign and store the grant, send it to the signal server. */
  approve(shareId, { agents, access = 'restricted', dailyCap = DEFAULT_DAILY_CAP } = {}) {
    const s = this._shares.find(x => x.id === shareId && x.as === 'owner' && ['pending', 'active'].includes(x.status));
    if (!s) throw new Error('No such request');
    if (!s.requester?.pubKey || !s.requester?.gatewayId) throw new Error("The requester's gateway hasn't connected with sharing support yet");
    const list = (Array.isArray(agents) ? agents : []).filter(a => a && typeof a.id === 'string' && a.id).map(a => ({ id: a.id, name: String(a.name || a.id).slice(0, 80) }));
    if (!list.length) throw new Error('Pick at least one agent');
    if (!ACCESS_MODES[access]) throw new Error('Unknown access level');
    const grant = {
      v: 1, shareId, ownerGatewayId: this.gatewayId(), requesterGatewayId: s.requester.gatewayId, requesterPubKey: s.requester.pubKey,
      requesterName: s.requester.name || s.requester.email || null,
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
    this.onShareRevoked(shareId);
    this._db().prepare('DELETE FROM peer_pins WHERE share_id = ?').run(shareId);
    this.signal({ type: 'share-revoke', shareId });
  }

  _usage(shareId) {
    return this._db().prepare('SELECT turns FROM peer_usage WHERE share_id = ? AND day = ?').get(shareId, today())?.turns || 0;
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
    link.handle('turn', (p, emit) => this._guestTurn(shareId, p, emit));
    link.handle('abort', async p => this._guestAbort(shareId, p?.turnId));
    return link;
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
    this._db().prepare('INSERT INTO peer_usage (share_id, day, turns) VALUES (?, ?, 1) ON CONFLICT(share_id, day) DO UPDATE SET turns = turns + 1').run(shareId, today());
    this._changed(); // the owner's Sharing view shows today's count

    const name = firstName({ name: grant.requesterName });
    const permissionMode = ACCESS_MODES[grant.access] || 'read-only';
    const toolOverrides = { webSearch: false };
    const sessionKey = await this._guestSession(shareId, roomId, agent.id, { name, roomTitle: String(p.roomTitle || 'team chat').slice(0, 80), permissionMode, toolOverrides });
    const runId = `peer-${crypto.randomUUID()}`;
    const turnKey = `${shareId}:${p.turnId || runId}`;
    const done = new Promise(resolve => {
      const timer = setTimeout(() => { this._runs.delete(runId); resolve({ state: 'error', errorMessage: 'timed out' }); }, TURN_TIMEOUT_MS + 30_000);
      timer.unref?.();
      this._runs.set(runId, { resolve, timer, text: '', emit });
    });
    this._turns.set(turnKey, { sessionKey, runId });
    try {
      await this.request('chat.send', {
        sessionKey, message: `${GUEST_NOTE(name)}\n\n${p.message}`, deliver: false, idempotencyKey: runId,
        timeoutMs: TURN_TIMEOUT_MS, suppressCommandInterpretation: true,
        expectedPermissionMode: permissionMode, expectedToolOverrides: toolOverrides,
      }, 30_000);
      const r = await done;
      if (r.state === 'final') return { state: 'final', text: r.message ? messageText(r.message) : await this._lastReply(sessionKey) };
      if (r.state === 'aborted') return { state: 'aborted', text: r.text || '' };
      throw Object.assign(new Error(r.errorMessage || 'The agent run failed'), { code: 'run_failed', partial: r.text || '' });
    } finally {
      this._turns.delete(turnKey);
      const run = this._runs.get(runId);
      if (run) { clearTimeout(run.timer); this._runs.delete(runId); }
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
    if (row) {
      // Re-apply the policy each turn: the owner may have changed the access level since.
      await this.request('sessions.patch', { key: row.session_key, permissionMode, toolOverrides }).catch(() => {});
      return row.session_key;
    }
    const key = `agent:${agentId}:dashboard:${crypto.randomUUID()}`;
    // Labels are unique per gateway, and untitled rooms all fall back to "team chat": tag each room.
    const tag = crypto.createHash('sha256').update(`${shareId}|${roomId}`).digest('hex').slice(0, 6);
    const create = label => this.request('sessions.create', {
      key, agentId, permissionMode, toolOverrides, label: label.slice(0, 200), category: `Shared with ${name}`.slice(0, 100),
    });
    try { await create(`${name} · ${roomTitle} · ${tag}`); }
    catch (e) {
      if (!/label already in use/i.test(e.message)) throw e;
      await create(`${name} · ${roomTitle} · ${tag}-${crypto.randomBytes(2).toString('hex')}`);
    }
    db.prepare('INSERT OR REPLACE INTO peer_sessions (share_id, room_id, agent_id, session_key) VALUES (?, ?, ?, ?)').run(shareId, roomId, agentId, key);
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
      const owner = firstName(s.owner);
      for (const a of grant.agents) out.push({ agentId: `peer:${s.id}:${a.id}`, name: `${a.name} · ${owner}`, ownerName: owner, shareId: s.id, remoteId: a.id });
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
      return link;
    })().finally(() => this._linking.delete(shareId));
    this._linking.set(shareId, p);
    return p;
  }

  /** Run a turn on a shared agent. Returns { state, text }; throws with `.partial` on failure. */
  async turn(agentId, { turnId, roomId, roomTitle, message }, { onDelta } = {}) {
    const id = SharingManager.parseRemoteId(agentId);
    if (!id) throw new Error('not a shared agent');
    const link = await this._link(id.shareId);
    return link.request('turn', { turnId, agentId: id.remoteId, roomId, roomTitle, message }, {
      onEvent: (event, data) => { if (event === 'delta' && typeof data === 'string') onDelta?.(data); },
      timeoutMs: TURN_TIMEOUT_MS + 60_000,
    });
  }

  async abort(agentId, turnId) {
    const id = SharingManager.parseRemoteId(agentId);
    const link = id && this._links.get(id.shareId);
    if (link?.ready) await link.request('abort', { turnId }, { timeoutMs: 10_000 }).catch(() => {});
  }

  close() {
    for (const l of this._links.values()) l.close();
    for (const l of this._served) l.close();
    this._links.clear();
  }
}
