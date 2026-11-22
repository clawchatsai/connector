// SearchIndexer: keeps the SearchStore (store.js) in step with the gateway's chats.
//
// Self-healing by construction: every chat carries the gateway's change stamp (its latest activity
// time) and the stamp it was last indexed at. Anything that can make the index fall behind only
// leaves a chat "stale", and stale chats are re-read until they're current:
//   - reconcile(): a full roster pass (on connect, then every RECONCILE_MS) adds new chats, drops
//     deleted/incognito/hidden ones, refreshes titles and archive state, and marks changed chats stale.
//     On an empty store this is the backfill.
//   - sessions.changed: the changed chat is marked stale and synced after a short quiet period.
//   - a weekly full re-read of every chat (a few per pass) catches drift a stamp can't show.
// A sync reads the chat through chat.history: the delta cursor from the last read when the
// gateway still accepts it (appended entries only), else every page (full read, replacing the
// chat's documents). Long messages the display cap truncated are fetched whole (chat.message.get);
// selection comments are read from the inbound media store once and cached.
//
// Events (the tagger, server/tags/, follows them): 'synced' (key) a chat's documents are current,
// 'removed' (key) a chat left the index (deleted, incognito, hidden), 'ready' the first full pass
// after a build finished.

import { EventEmitter } from 'node:events';
import { documentsOf, entryMeta, parseSelectionComment } from './text.js';

const idOf = m => entryMeta(m)?.meta.id ?? null;

// Bump when what a chat's documents are made of changes (text.js rules, delta handling): every chat
// indexed by an older connector is then read again whole.
export const INDEXER_VERSION = 3; // 3: text from other chats is role 'chat', without its envelope
const RECONCILE_MS = 10 * 60 * 1000;
const QUIET_MS = 3000;          // a chat syncs this long after its last change...
const MAX_WAIT_MS = 20_000;     // ...but no later than this after the first one
const FULL_READ_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const FULL_READS_PER_PASS = 10;
const PAGE_LIMIT = 200;
const PAGE_BYTES = 4 * 1024 * 1024;
const MAX_CHARS = 200_000;      // chat.history text cap per entry (gateway default 8000)
const MAX_PAGES = 200;
const MAX_DELTA_ROUNDS = 25;
const MAX_FULL_FETCHES = 100;   // truncated entries fetched whole per sync
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];
const LIST_PAGE = 1000;
const backoffMs = attempts => BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_MS.length - 1)];

/** The gateway's change stamp for a session row: its latest activity. */
export function stampOf(row) {
  return Math.max(0, ...['updatedAt', 'lastActivityAt', 'lastInteractionAt'].map(k => Number(row?.[k]) || 0));
}

/** The chat title the browser shows (ChatStore.threadTitle), for title matching. */
export function titleOf(row) {
  const t = row && (row.label || row.displayName || row.derivedTitle || row.autoLabel);
  return typeof t === 'string' ? t.trim() : '';
}

export class SearchIndexer extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./store.js').SearchStore} o.store
   * @param {(method: string, params: object, timeoutMs?: number) => Promise<any>} o.request  gateway RPC
   * @param {(url: string, meta: { sessionKey: string, field: string }) => Promise<string|null>} o.fetchComment
   *        body of an inbound media file, null when the gateway no longer has it
   * @param {{ observe(key, row): boolean, isVisible(key): boolean }} o.lens  which sessions are ClawChats chats
   * @param {{ room(key): object|null }} [o.team]  team chats: room author maps
   * @param {(frame: object) => void} [o.notify]  status changes for browsers
   */
  constructor({ store, request, fetchComment, lens, team = null, notify = () => {}, logger = console, now = () => Date.now(), quietMs = QUIET_MS, maxWaitMs = MAX_WAIT_MS }) {
    super();
    Object.assign(this, { store, request, fetchComment, lens, team, notify, log: logger, now, quietMs, maxWaitMs });
    this.timers = new Map();   // key -> { timer, first }
    this.queue = new Set();    // keys waiting for a sync, in order
    this.running = false;
    this.connected = false;
    this.reconciling = null;
    this.lastReconcileAt = null;
    this.interval = null;
    this.closed = false;
    if (store.requireIndexerVersion(INDEXER_VERSION)) this.log.info?.(`[search] indexer v${INDEXER_VERSION}: every chat will be re-read`);
  }

  start() {
    this.interval = setInterval(() => { if (this.connected) this.reconcile().catch(() => {}); }, RECONCILE_MS);
    this.interval.unref?.();
  }

  close() {
    this.closed = true;
    clearInterval(this.interval);
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
    this.queue.clear();
  }

  onConnected() {
    this.connected = true;
    this.reconcile().catch(e => this.log.warn?.(`[search] reconcile: ${e.message}`));
  }

  onDisconnected() { this.connected = false; }

  /** Status for the browser: whether results are complete yet, and coverage numbers. */
  status() {
    const s = this.store.stats();
    const pending = s.chats - s.current;
    return {
      ready: this.store.completedAt != null,
      building: this.running || !!this.reconciling || pending > 0,
      pending, ...s,
      completedAt: this.store.completedAt, lastReconcileAt: this.lastReconcileAt,
    };
  }

  _notify() {
    clearTimeout(this._notifyTimer);
    this._notifyTimer = setTimeout(() => { try { this.notify({ type: 'clawchats', event: 'search-index', status: this.status() }); } catch { /* no browsers */ } }, 500);
    this._notifyTimer.unref?.();
  }

  /** Throw the index away and build it again from the gateway. */
  async rebuild() {
    this.queue.clear();
    this.store.reset();
    this._notify();
    if (this.connected) await this.reconcile();
  }

  // ── Roster ────────────────────────────────────────────────────────

  /** Whether a session's transcript belongs in the index. */
  _indexable(key, row) {
    if (!key || row?.incognito) return false;
    const visible = row && typeof row === 'object' ? this.lens.observe(key, row) : this.lens.isVisible(key);
    return visible && !this.lens.parentOf?.(key);
  }

  reconcile() {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this._reconcile().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  async _reconcile() {
    const rows = [];
    let offset = 0, complete = false;
    for (let page = 0; page < 50; page++) {
      const res = await this.request('sessions.list', { archived: 'all', limit: LIST_PAGE, offset, includeDerivedTitles: true, excludeCron: true, excludeSystem: true }, 60_000);
      // A reply without a roster is a failure, never "the gateway has no chats" (that would drop the index).
      if (!Array.isArray(res?.sessions)) throw new Error('sessions.list returned no session list');
      rows.push(...res.sessions);
      if (!res?.hasMore || res.nextOffset == null || res.nextOffset <= offset) { complete = !res?.hasMore; break; }
      offset = res.nextOffset;
    }
    // Learn the whole roster before judging rows: a child can be listed before its parent.
    for (const row of rows) if (row?.key) this.lens.observe(row.key, row);
    const live = new Set();
    for (const row of rows) {
      if (!row?.key || !this._indexable(row.key, row)) continue;
      live.add(row.key);
      this.store.upsertChat({ key: row.key, agentId: row.agentId || row.key.split(':')[1] || null, title: titleOf(row), archived: !!row.archived, stamp: stampOf(row) });
    }
    // Only a complete roster proves a chat is gone.
    if (complete) for (const key of this.store.chatKeys()) if (!live.has(key)) this._remove(key);
    for (const key of this.store.staleKeys()) this._enqueue(key);
    for (const key of this.store.dueForFullRead(this.now() - FULL_READ_EVERY_MS, FULL_READS_PER_PASS)) {
      if (this.store.getChat(key)?.full_at != null) this._enqueue(key, { full: true });
    }
    this.lastReconcileAt = this.now();
    this._notify();
    this._drain();
  }

  /** `sessions.changed` from the connector's subscription (gateway.js). */
  onSessionsChanged(payload) {
    const key = payload?.sessionKey;
    if (!key || this.closed) return;
    if (payload.reason === 'delete') { if (this._remove(key)) this._notify(); return; }
    const row = payload.session && typeof payload.session === 'object' ? { key, ...payload.session } : { key, ...payload };
    if (!this._indexable(key, row)) {
      // Became incognito/hidden/nested: its documents go. Undecided partial rows change nothing.
      if (row.incognito || this.lens.isVisible(key) === false) { if (this._remove(key)) this._notify(); }
      return;
    }
    const prev = this.store.getChat(key);
    const title = 'label' in row || 'displayName' in row || 'derivedTitle' in row || 'autoLabel' in row ? titleOf(row) : prev?.title || '';
    const archived = 'archived' in row ? !!row.archived : !!prev?.archived;
    const stamp = Math.max(stampOf(row), prev?.stamp || 0, this.now());
    this.store.upsertChat({ key, agentId: row.agentId || prev?.agent_id || key.split(':')[1] || null, title, archived, stamp });
    this._schedule(key);
  }

  _remove(key) {
    const gone = this.store.deleteChat(key);
    if (gone) this.emit('removed', key);
    return gone;
  }

  // ── Queue ─────────────────────────────────────────────────────────

  /** Debounced sync: quiet period after the last change, bounded by maxWaitMs; `delayMs` = a retry. */
  _schedule(key, delayMs = null) {
    const t = this.timers.get(key);
    const first = t?.first ?? this.now();
    if (t) clearTimeout(t.timer);
    const wait = delayMs ?? Math.max(0, Math.min(this.quietMs, first + this.maxWaitMs - this.now()));
    const timer = setTimeout(() => { this.timers.delete(key); this._enqueue(key); this._drain(); }, wait);
    timer.unref?.();
    this.timers.set(key, { timer, first });
  }

  _enqueue(key, { full = false } = {}) {
    if (full) (this._fullNext ??= new Set()).add(key);
    this.queue.add(key);
  }

  _drain() {
    if (!this.running && !this.closed) this.draining = this._drainLoop();
    return this.draining;
  }

  /** Resolves once no reconcile, sync or debounced change is outstanding (tests, rebuild). */
  async idle() {
    for (let i = 0; i < 100; i++) {
      if (this.reconciling) await this.reconciling.catch(() => {});
      else if (this.running) await this.draining;
      else if (this.timers.size) await new Promise(r => setTimeout(r, Math.min(this.quietMs, 50) + 1));
      else if (this.queue.size && this.connected) await this._drain();
      else return;
    }
  }

  async _drainLoop() {
    this.running = true;
    try {
      while (this.queue.size && this.connected && !this.closed) {
        const key = this.queue.values().next().value;
        this.queue.delete(key);
        const chat = this.store.getChat(key);
        if (!chat) continue;
        const full = !!this._fullNext?.delete(key);
        if (!full && chat.synced_stamp >= chat.stamp && !chat.error) continue;
        if (chat.error) {
          // Failing chats wait out their backoff (a later change can't shorten it).
          const left = chat.error_at + backoffMs(chat.attempts) - this.now();
          if (left > 0) { this._schedule(key, left); continue; }
        }
        try { await this.syncChat(key, { full }); this.emit('synced', key); }
        catch (e) {
          if (!this.connected) { this.queue.add(key); break; } // the gateway went away: not this chat's fault
          if (this.store.getChat(key)) {
            this.store.markFailed(key, e.message, this.now());
            this._schedule(key, backoffMs(this.store.getChat(key).attempts));
          }
          this.log.warn?.(`[search] ${key}: ${e.message}`);
        }
        this._notify();
      }
      if (!this.queue.size && this.store.stats().neverIndexed === 0 && this.store.completedAt == null && this.lastReconcileAt) {
        this.store.completedAt = this.now();
        this.emit('ready');
        this._notify();
      }
    } finally {
      this.running = false;
    }
  }

  // ── Sync one chat ─────────────────────────────────────────────────

  /**
   * Bring one chat up to date. Cheapest first: the delta since the last read; else a one-entry probe
   * (same window, same entry count, same last entry = unchanged); else a full read. `full` skips
   * both shortcuts (the weekly drift check).
   */
  async syncChat(key, { full = false } = {}) {
    const chat = this.store.getChat(key);
    if (!chat) return;
    const stamp = chat.stamp; // indexed up to here; a change during the read re-marks it stale
    const team = this.team?.room?.(key)?.authors || null;
    const indexed = chat.synced_at != null;
    if (!full && indexed && chat.cursor) {
      const delta = await this._readDelta(key, chat.cursor);
      if (delta) {
        const docs = await this._documents(key, delta.messages, team);
        this.store.writeDocs(key, docs, { full: false, sessionId: chat.session_id, cursor: delta.cursor, stamp, now: this.now() });
        return;
      }
    }
    if (!full && indexed && !chat.cursor && chat.total != null) {
      const probe = await this.request('chat.history', { sessionKey: key, limit: 1, maxBytes: 256 * 1024, maxChars: 1000 }, 30_000);
      const last = (probe?.messages || []).at(-1);
      if (probe?.sessionId === chat.session_id && probe?.totalMessages === chat.total && idOf(last) === chat.last_id) {
        this.store.markSynced(key, stamp, this.now());
        return;
      }
    }
    const read = await this._readAll(key);
    const docs = await this._documents(key, read.messages, team);
    this.store.writeDocs(key, docs, { full: true, sessionId: read.sessionId, cursor: read.cursor, total: read.total, lastId: read.lastId, stamp, now: this.now() });
  }

  /** Entries appended since `cursor`, or null when the gateway wants a full read (branch changed, window reset, unknown cursor). */
  async _readDelta(key, cursor) {
    const messages = [];
    let cur = cursor;
    for (let round = 0; round < MAX_DELTA_ROUNDS; round++) {
      let res;
      try { res = await this.request('chat.history', { sessionKey: key, cursor: cur, maxBytes: PAGE_BYTES, maxChars: MAX_CHARS }, 60_000); }
      catch (e) { if (/cursor|invalid|reset/i.test(e.message)) return null; throw e; }
      if (res?.kind !== 'delta' || typeof res.deltaCursor !== 'string') return null;
      // Delta entries are session.message payloads ({ sessionKey, message, messageId, … }), not bare entries.
      const batch = (Array.isArray(res.messages) ? res.messages : []).map(e => (e?.message && typeof e.message === 'object' ? e.message : e));
      messages.push(...batch);
      if (!batch.length || res.deltaCursor === cur) return { messages, cursor: res.deltaCursor };
      cur = res.deltaCursor;
    }
    return null; // a delta this long is cheaper read whole
  }

  /** Every page of a chat's history, newest first from the gateway, returned oldest first. */
  async _readAll(key) {
    const pages = [];
    let offset = 0, sessionId = null, cursor = null, total = null, lastId = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.request('chat.history', { sessionKey: key, limit: PAGE_LIMIT, offset, maxBytes: PAGE_BYTES, maxChars: MAX_CHARS }, 60_000);
      if (page === 0) {
        sessionId = res?.sessionId || null;
        cursor = typeof res?.deltaCursor === 'string' ? res.deltaCursor : null;
        total = Number.isInteger(res?.totalMessages) ? res.totalMessages : null;
        lastId = idOf((res?.messages || []).at(-1));
      }
      else if (res?.sessionId && sessionId && res.sessionId !== sessionId) throw new Error('chat was reset while it was being read');
      pages.unshift(Array.isArray(res?.messages) ? res.messages : []);
      const next = res?.nextOffset;
      if (!res?.hasMore || !Number.isFinite(next) || next <= offset) break;
      offset = next;
    }
    const seen = new Set();
    const messages = [];
    for (const m of pages.flat()) {
      const id = idOf(m);
      if (id && seen.has(id)) continue; // pages can overlap while the chat grows
      if (id) seen.add(id);
      messages.push(m);
    }
    return { messages, sessionId, cursor, total, lastId };
  }

  /** History entries → store documents (whole text for truncated entries, comment bodies resolved). */
  async _documents(key, messages, team) {
    const out = [];
    let fetches = 0;
    for (let m of messages) {
      let entry = documentsOf(m, { team });
      if (!entry) continue;
      if (entry.truncated && fetches < MAX_FULL_FETCHES) {
        fetches++;
        const whole = await this._wholeMessage(key, entry.id);
        if (whole) { m = whole; entry = documentsOf(m, { team }) || entry; }
      }
      for (const d of entry.docs) out.push({ messageId: entry.id, kind: d.kind, role: d.role, ts: entry.ts, text: d.text });
      for (let i = 0; i < entry.comments.length; i++) {
        const parsed = parseSelectionComment(await this._commentBody(key, m, entry.comments[i].url));
        if (parsed && (parsed.comment || parsed.quote)) out.push({ messageId: entry.id, kind: 'comment', ord: i, role: 'user', ts: entry.ts, text: parsed.comment, quote: parsed.quote });
      }
    }
    return out;
  }

  async _wholeMessage(key, messageId) {
    try {
      const res = await this.request('chat.message.get', { sessionKey: key, messageId, maxChars: 500_000 }, 30_000);
      return res?.ok && res.message && typeof res.message === 'object' ? res.message : null;
    } catch { return null; } // keep the capped text
  }

  async _commentBody(key, m, url) {
    const cached = this.store.commentFile(url, this.now());
    if (cached?.body != null) return cached.body;
    if (cached?.missing) return null;
    const field = Object.keys(m).find(k => k.startsWith('__') && m[k]?.media) || '__openclaw';
    const body = await this.fetchComment(url, { sessionKey: key, field });
    this.store.putCommentFile(url, typeof body === 'string' ? body.slice(0, 256 * 1024) : null, this.now());
    return body;
  }
}
