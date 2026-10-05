// TeamCoordinator: several agents in one ClawChats thread (a "team chat").
//
// The gateway has no multi-agent session, so a team chat is:
//   - a room session: a normal gateway session that never runs. Its transcript is the shared
//     timeline; every entry is written with `chat.inject` and a "[Label]" prefix (the gateway
//     stores the label as that prefix). Authors are recorded in TeamStore.team_entries.
//   - one working session per agent, where the agent actually runs. Each turn it gets the room
//     entries it hasn't seen yet; its final reply is injected into the room.
//
// Routing follows the gateway's broadcast group threads (docs/channels/broadcast-groups.md):
// @mentioned agents answer; with no mention every agent gets the message but is told to answer
// NO_REPLY unless it's for them (ClawChats choice); `@all` makes everyone answer. Follow-up rounds
// (the room's "discuss" toggle) go to agents that replied or were named, with the siblings'
// replies, until everyone passes or the round/turn caps are hit. Round state is in memory only.

import crypto from 'node:crypto';

export const SILENT = /^\s*NO_REPLY\s*$/i;
const LABEL_PREFIX = /^\[([^\]\n]{1,100})\]\n\n/;
const TURN_TIMEOUT_MS = 15 * 60_000;
const HISTORY_LIMIT = 80;
const AGENTS_TTL_MS = 60_000;
const ALL_WORDS = new Set(['all', 'everyone']);

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');

/** Text of a transcript/chat message (string content or text parts). */
export function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  return typeof message?.text === 'string' ? message.text : '';
}

/** Transcript entry id: a `__`-prefixed metadata object with a string id (never named in code). */
export function entryId(message) {
  for (const k of Object.keys(message || {})) {
    if (k.startsWith('__') && message[k] && typeof message[k] === 'object' && typeof message[k].id === 'string') return message[k].id;
  }
  return null;
}

/** "[Label]\n\nbody" → { label, body }. */
export function splitLabel(text) {
  const m = LABEL_PREFIX.exec(text || '');
  return m ? { label: m[1], body: text.slice(m[0].length) } : { label: null, body: text || '' };
}

/**
 * Who a message addresses. `agents`: [{ agentId, name }].
 * Returns { all: true } for @all/@everyone, else { agentIds: [...] } (empty = nobody mentioned).
 */
export function parseMentions(text, agents) {
  const ids = new Set();
  const re = /(^|[^\w@])@([\w.-]+)/g;
  let m;
  while ((m = re.exec(text || ''))) {
    const word = norm(m[2]).replace(/[.-]+$/, '');
    if (ALL_WORDS.has(word)) return { all: true };
    for (const a of agents) if (word === norm(a.agentId) || (a.name && word === norm(a.name))) ids.add(a.agentId);
  }
  return { agentIds: [...ids] };
}

/** Agents a reply names, by @mention or as a whole word (for follow-up eligibility). */
export function namedIn(text, agents) {
  const out = new Set(parseMentions(text, agents).agentIds || []);
  const lower = (text || '').toLowerCase();
  for (const a of agents) {
    for (const n of [a.agentId, a.name]) {
      if (!n || n.length < 2) continue;
      const esc = n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^\\w])${esc}([^\\w]|$)`).test(lower)) out.add(a.agentId);
    }
  }
  return [...out];
}

export class TeamCoordinator {
  /**
   * @param {object} opts
   * @param {object} opts.store       TeamStore
   * @param {(method: string, params: object, timeoutMs?: number) => Promise<any>} opts.request  gateway RPC
   * @param {(data: string) => void} opts.broadcast  frame to all browsers
   */
  constructor({ store, request, broadcast, titler = null, logger = console }) {
    this.store = store;
    this.request = request;
    this.broadcast = broadcast;
    this.titler = titler; // main-model title fallback (controllers/title.js createTitler)
    this.log = logger;
    this._workKeys = null;     // cached Set of working session keys
    this._waiters = new Map(); // runId -> { resolve, timer }
    this._chains = new Map();  // roomKey -> tail promise (one message at a time per room)
    this._rooms = new Map();   // roomKey -> { running: Map<agentId, {workKey, runId}>, queued, stopped }
    this._agents = null;       // { at, list }
  }

  // ── Lens hooks ─────────────────────────────────────────────────────

  isWorkKey(key) {
    if (!this._workKeys) this._workKeys = this.store.workKeys();
    return this._workKeys.has(key);
  }

  _workKeysChanged() { this._workKeys = null; }

  /** The gateway reported a session deleted. */
  onSessionDeleted(key) {
    if (this.store.getRoom(key)) {
      this.stop(key);
      const work = this.store.deleteRoom(key);
      this._workKeysChanged();
      for (const w of work) this.request('sessions.delete', { key: w }).catch(e => this.log.warn?.(`[team] delete ${w}: ${e.message}`));
      this._changed();
      return;
    }
    const ws = this.store.workSession(key);
    if (ws) { this.store.setWorkKey(ws.roomKey, ws.agentId, null); this._workKeysChanged(); }
  }

  /** Every gateway event (before the lens filters it). Resolves run waiters. */
  onGatewayEvent(msg) {
    if (msg?.event !== 'chat') return;
    const p = msg.payload;
    const w = p?.runId && this._waiters.get(p.runId);
    if (!w) return; // includes the stray `error` that follows a silent final
    if (p.state === 'delta') {
      // Streamed text so far, kept for a Stop mid-reply: first delta carries the message, later
      // ones the appended text (`replace`: the whole text).
      if (p.message && !w.text) w.text = messageText(p.message);
      else if (typeof p.deltaText === 'string') w.text = p.replace ? p.deltaText : (w.text || '') + p.deltaText;
      return;
    }
    if (!['final', 'aborted', 'error'].includes(p.state)) return;
    this._waiters.delete(p.runId);
    clearTimeout(w.timer);
    w.resolve({ ...p, partialText: w.text || '' });
  }

  // ── Agents ─────────────────────────────────────────────────────────

  async agents() {
    if (this._agents && Date.now() - this._agents.at < AGENTS_TTL_MS) return this._agents.list;
    const res = await this.request('agents.list', {});
    const list = (res?.agents || []).map(a => ({ agentId: a.id, name: a.identity?.name || a.name || a.id }));
    this._agents = { at: Date.now(), list };
    return list;
  }

  async _named(agentIds) {
    const all = await this.agents();
    return agentIds.map(id => all.find(a => a.agentId === id) || { agentId: id, name: id });
  }

  // ── Rooms ──────────────────────────────────────────────────────────

  rooms() {
    return this.store.listRooms().map(r => this._publicRoom(r));
  }

  room(roomKey) {
    const r = this.store.getRoom(roomKey);
    return r ? { ...this._publicRoom(r), authors: this.store.authors(roomKey) } : null;
  }

  _publicRoom(r) {
    const live = this._rooms.get(r.roomKey);
    return {
      roomKey: r.roomKey,
      discuss: r.discuss,
      sourceKey: r.sourceKey,
      createdAt: r.createdAt,
      agents: r.members.map(m => ({ agentId: m.agentId, workKey: m.workKey })),
      running: live ? [...live.running.keys()] : [],
      queued: live?.queued || 0,
    };
  }

  /**
   * Create a team chat. With `sourceKey`, an existing chat becomes the first agent's working
   * session (it keeps its memory) and is hidden from the thread list.
   */
  async createRoom({ agentIds = [], sourceKey = null, category, label } = {}) {
    const agents = [...new Set(agentIds.filter(a => typeof a === 'string' && a))];
    const members = [];
    if (sourceKey) {
      const src = /^agent:([^:]+):/.exec(sourceKey)?.[1];
      if (!src) throw new Error('invalid sourceKey');
      if (this.isWorkKey(sourceKey) || this.store.getRoom(sourceKey)) throw new Error('chat is already part of a team chat');
      members.push({ agentId: src, workKey: sourceKey, seenAt: Date.now() });
    }
    for (const a of agents) if (!members.some(m => m.agentId === a)) members.push({ agentId: a });
    if (members.length < 2) throw new Error('a team chat needs at least two agents');
    const known = new Set((await this.agents()).map(a => a.agentId));
    const unknown = members.find(m => !known.has(m.agentId));
    if (unknown) throw new Error(`unknown agent: ${unknown.agentId}`);

    const roomKey = `agent:${members[0].agentId}:dashboard:${crypto.randomUUID()}`;
    // Register first so the lens never shows a working session or forwards a half-made room.
    this.store.createRoom(roomKey, members, { sourceKey });
    this._workKeysChanged();
    try {
      await this.request('sessions.create', {
        key: roomKey, agentId: members[0].agentId,
        ...(typeof category === 'string' && category ? { category } : {}),
        ...(typeof label === 'string' && label.trim() ? { label: label.trim().slice(0, 200) } : {}),
      });
    } catch (e) {
      this.store.deleteRoom(roomKey);
      this._workKeysChanged();
      throw e;
    }
    this._changed();
    return this.room(roomKey);
  }

  async addAgent(roomKey, agentId) {
    if (!(await this.agents()).some(a => a.agentId === agentId)) throw new Error(`unknown agent: ${agentId}`);
    if (!this.store.addMember(roomKey, agentId)) return null;
    this._changed();
    return this.room(roomKey);
  }

  removeAgent(roomKey, agentId) {
    const r = this.store.getRoom(roomKey);
    if (!r) return null;
    if (r.members.length <= 2 && r.members.some(m => m.agentId === agentId)) throw new Error('a team chat needs at least two agents');
    // The working session stays (it's that agent's history); it shows up as its own chat again.
    this.store.removeMember(roomKey, agentId);
    this._workKeysChanged();
    this._changed();
    return this.room(roomKey);
  }

  setDiscuss(roomKey, discuss) {
    if (!this.store.getRoom(roomKey)) return null;
    this.store.setDiscuss(roomKey, !!discuss);
    this._changed();
    return this.room(roomKey);
  }

  // ── Messages ───────────────────────────────────────────────────────

  /** Post a user message; agents run in the background. Resolves once the message is in the room. */
  async send(roomKey, { text, userLabel = 'User' } = {}) {
    const room = this.store.getRoom(roomKey);
    if (!room) throw new Error('not a team chat');
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty message');
    const label = String(userLabel || 'User').replace(/[\[\]\n]/g, '').trim().slice(0, 100) || 'User';
    const res = await this.request('chat.inject', { sessionKey: roomKey, message: text, label });
    if (res?.messageId) this.store.recordEntry(roomKey, res.messageId, { type: 'user' });
    this._maybeTitle(roomKey, text);

    const live = this._live(roomKey);
    const gen = live.gen; // Stop bumps the generation: everything queued before it is dropped
    live.queued++;
    this._status(roomKey);
    const prev = this._chains.get(roomKey) || Promise.resolve();
    const next = prev.then(async () => {
      live.queued--;
      if (live.gen !== gen) return;
      await this._runMessage(roomKey, text, () => live.gen !== gen);
    }).catch(e => {
      this.log.error?.(`[team] ${roomKey}: ${e.message}`);
      this._status(roomKey, e.message);
    }).finally(() => { if (this._chains.get(roomKey) === next) this._chains.delete(roomKey); this._status(roomKey); });
    this._chains.set(roomKey, next);
    return { messageId: res?.messageId || null };
  }

  /** Abort running agents and drop queued messages. */
  async stop(roomKey) {
    const live = this._rooms.get(roomKey);
    if (!live) return;
    live.gen++;
    await Promise.all([...live.running.values()].map(r =>
      this.request('chat.abort', { sessionKey: r.workKey, runId: r.runId }).catch(e => this.log.warn?.(`[team] abort: ${e.message}`))));
    this._status(roomKey);
  }

  async _runMessage(roomKey, text, stopped = () => false) {
    const room = this.store.getRoom(roomKey);
    if (!room) return;
    const agents = await this._named(room.members.map(m => m.agentId));
    const mention = parseMentions(text, agents);
    let targets, mode;
    if (mention.all) { targets = agents.map(a => a.agentId); mode = 'addressed'; }
    else if (mention.agentIds.length) { targets = mention.agentIds; mode = 'addressed'; }
    else { targets = agents.map(a => a.agentId); mode = 'open'; }

    const maxRounds = room.discuss ? this.store.DISCUSS_ROUNDS : 1;
    const maxTurns = room.discuss ? agents.length * 2 : agents.length;
    let turns = 0;
    for (let round = 1; round <= maxRounds && targets.length && turns < maxTurns && !stopped(); round++) {
      targets = targets.slice(0, maxTurns - turns);
      turns += targets.length;
      const history = await this._roomEntries(roomKey);
      const results = await Promise.all(targets.map(agentId =>
        this._turn(roomKey, agentId, agents, history, round === 1 ? mode : 'followup', stopped)
          .catch(async e => {
            // Shown in the room, like a failed turn in a normal chat, not only as a passing toast.
            this.log.warn?.(`[team] ${agentId} in ${roomKey}: ${e.message}`);
            const self = agents.find(a => a.agentId === agentId) || { agentId, name: agentId };
            const note = `${e.partial ? `${e.partial}\n\n` : ''}⚠️ *Couldn't finish this reply: ${e.message}*`;
            await this._post(roomKey, self, note).catch(() => this._status(roomKey, `${agentId}: ${e.message}`));
            return null;
          })));
      const replied = results.filter(r => r?.text);
      if (!replied.length || stopped()) break;
      // Next round: agents that replied or were named, if a sibling said something they haven't seen.
      const eligible = new Set(replied.map(r => r.agentId));
      for (const r of replied) for (const id of namedIn(r.text, agents)) if (id !== r.agentId) eligible.add(id);
      targets = agents.map(a => a.agentId).filter(id => eligible.has(id) && replied.some(r => r.agentId !== id));
    }
  }

  /** One agent turn. Returns { agentId, text } (text null when silent/aborted). */
  async _turn(roomKey, agentId, agents, history, mode, stopped = () => false) {
    const room = this.store.getRoom(roomKey);
    const member = room?.members.find(m => m.agentId === agentId);
    if (!member) return null;
    const self = agents.find(a => a.agentId === agentId) || { agentId, name: agentId };
    const authors = this.store.authors(roomKey);
    const fresh = history.filter(e => e.ts > member.seenAt && authors[e.id]?.agentId !== agentId);
    if (!fresh.length) return null;

    const workKey = member.workKey || await this._createWorkSession(roomKey, self);
    const message = this._prompt(self, agents, fresh, mode);
    const runId = `team-${crypto.randomUUID()}`;
    const live = this._live(roomKey);
    const done = this._waitRun(runId);
    live.running.set(agentId, { workKey, runId });
    this._status(roomKey);
    let result;
    try {
      await this.request('chat.send', { sessionKey: workKey, message, deliver: false, idempotencyKey: runId }, 30_000);
      this.store.setSeenAt(roomKey, agentId, Math.max(...fresh.map(e => e.ts)));
      result = await done;
    } finally {
      this._cancelWait(runId);
      live.running.delete(agentId);
      this._status(roomKey);
    }
    const clean = t => {
      const own = splitLabel((t || '').trim());
      return (own.label && norm(own.label) === norm(self.name) ? own.body : (t || '')).trim(); // agent copied the room format
    };
    if (result.state !== 'final') {
      // Stopped or failed mid-reply: the agent's session keeps what it said, so the room shows it too
      // (a normal chat keeps a stopped reply's partial text the same way).
      const partial = clean(result.partialText);
      if (result.state === 'aborted') {
        if (partial && !SILENT.test(partial)) await this._post(roomKey, self, `${partial}\n\n*[stopped]*`);
        return { agentId, text: null };
      }
      throw Object.assign(new Error(result.errorMessage || 'run failed'), { partial });
    }
    const text = clean(result.message ? messageText(result.message) : await this._lastReply(workKey));
    if (!text || SILENT.test(text)) return { agentId, text: null };
    await this._post(roomKey, self, text);
    // A reply that finished after Stop is still posted (the agent said it), but starts no new round.
    return { agentId, text: stopped() ? null : text };
  }

  /** Post an agent's message into the room. */
  async _post(roomKey, self, text) {
    const res = await this.request('chat.inject', { sessionKey: roomKey, message: text, label: self.name.slice(0, 100) });
    if (res?.messageId) this.store.recordEntry(roomKey, res.messageId, { type: 'agent', agentId: self.agentId });
  }

  _prompt(self, agents, fresh, mode) {
    const others = agents.filter(a => a.agentId !== self.agentId).map(a => a.name);
    const lines = fresh.map(e => {
      const { label, body } = splitLabel(e.text);
      return `[${label || 'unknown'}]: ${body}`;
    });
    const instruction = {
      addressed: 'The latest message is addressed to you. Reply to the team chat.',
      open: 'The latest message is not addressed to anyone in particular. Reply only if it is clearly meant for you or you have something distinct to add; otherwise reply with exactly NO_REPLY.',
      followup: 'Other participants just replied (above). Reply only if you have something new to add or were asked something; otherwise reply with exactly NO_REPLY. Do not just agree or repeat what was said.',
    }[mode];
    return [
      `[Team chat] You are ${self.name}. Other agents here: ${others.join(', ') || 'none'}. Your reply is posted to the team chat as ${self.name}; address someone with @name.`,
      '',
      'New messages since your last turn:',
      '',
      lines.join('\n\n'),
      '',
      instruction,
    ].join('\n');
  }

  async _createWorkSession(roomKey, self) {
    const workKey = `agent:${self.agentId}:dashboard:${crypto.randomUUID()}`;
    this.store.setWorkKey(roomKey, self.agentId, workKey); // before create: the lens hides it from the first event
    this._workKeysChanged();
    try {
      await this.request('sessions.create', { key: workKey, agentId: self.agentId, label: `${self.name} · team chat ${roomKey.slice(-8)}` }); // labels are unique per gateway
    } catch (e) {
      this.store.setWorkKey(roomKey, self.agentId, null);
      this._workKeysChanged();
      throw e;
    }
    this._changed();
    return workKey;
  }

  /** Room transcript entries, oldest first: { id, ts, text }. */
  async _roomEntries(roomKey) {
    const h = await this.request('chat.history', { sessionKey: roomKey, limit: HISTORY_LIMIT }, 30_000);
    return (h?.messages || [])
      .map(m => ({ id: entryId(m), ts: Number(m.timestamp) || 0, text: messageText(m) }))
      .filter(e => e.id && e.text);
  }

  /** Newest assistant text after the last user message (a final without a message). */
  async _lastReply(workKey) {
    const h = await this.request('chat.history', { sessionKey: workKey, limit: 20 }, 30_000);
    const msgs = h?.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') return '';
      if (msgs[i].role === 'assistant') { const t = messageText(msgs[i]); if (t.trim()) return t; }
    }
    return '';
  }

  /**
   * Room sessions never run, so the gateway's first-message titler never fires. Same chain as
   * ClawChats' regenerate-title: the gateway's utility titler, else the main model.
   */
  _maybeTitle(roomKey, text) {
    this.request('sessions.describe', { key: roomKey }, 5000).then(async res => {
      const s = res?.session;
      if (!s || s.label || s.autoLabel || s.derivedTitle) return;
      const agentId = /^agent:([^:]+):/.exec(roomKey)?.[1];
      const message = Array.from(text).slice(0, 1000).join('');
      let title = (await this.request('sessions.title.prepare', { agentId, message }, 30_000).catch(() => null))?.title;
      if (!title && this.titler) title = await this.titler(message);
      if (title) await this.request('sessions.patch', { key: roomKey, label: title });
    }).catch(e => this.log.warn?.(`[team] title: ${e.message}`));
  }

  // ── Plumbing ───────────────────────────────────────────────────────

  _waitRun(runId) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this._waiters.delete(runId); resolve({ state: 'error', errorMessage: 'timed out' }); }, TURN_TIMEOUT_MS);
      timer.unref?.();
      this._waiters.set(runId, { resolve, timer });
    });
  }

  _cancelWait(runId) {
    const w = this._waiters.get(runId);
    if (w) { clearTimeout(w.timer); this._waiters.delete(runId); }
  }

  _live(roomKey) {
    let l = this._rooms.get(roomKey);
    if (!l) { l = { running: new Map(), queued: 0, gen: 0 }; this._rooms.set(roomKey, l); }
    return l;
  }

  _status(roomKey, error) {
    const live = this._rooms.get(roomKey);
    this.broadcast(JSON.stringify({
      type: 'clawchats', event: 'team-status', roomKey,
      running: live ? [...live.running.keys()] : [], queued: live?.queued || 0,
      ...(error ? { error } : {}),
    }));
  }

  _changed() {
    this.broadcast(JSON.stringify({ type: 'clawchats', event: 'team-changed' }));
  }
}
