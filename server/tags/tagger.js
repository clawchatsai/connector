// Tagger: gives each chat a one-line summary and a few tags, so search finds it by topic and the
// user can browse by subject (#proxmox). Runs in the connector, whether or not a browser is open.
//
// When: a chat is tagged once it has MIN_MESSAGES messages and has been quiet for QUIET_MS after
// the search index (server/search/) caught up with it, and tagged again once it has grown by half
// (and at least REGROW_MIN messages): the topic of a long chat drifts. Chats whose last activity
// predates tagging (the `since` mark) are the user's history: they're only tagged after the user
// accepts the backfill offer, which states the cost first.
//
// Input: the chat's text from the search index, so tagging never reads the gateway itself. Output:
// the tag store (store.js, global.db), copied into the index (chat_meta) so search matches it.
//
// Model: a host-run completion (api.runtime.llm.complete, no session). The owner's choice comes first:
// plugins.entries.connector.config.tags.model, any model ref the gateway resolves, including one of its
// aliases (`haiku`), so a model upgrade is made in one place. Without it a cheap model is asked for
// (CHEAP_MODELS). Either needs plugins.entries.connector.llm.allowModelOverride (+ allowedModels when the
// owner restricts it), otherwise the call is refused before any inference and the gateway's default
// model is used. One chat at a time.

import { createCompletion } from '../controllers/title.js';
import { SYSTEM_PROMPT, buildPrompt, condense, parseReply, estimateCost, isSubscription } from './model.js';

export const MIN_MESSAGES = 6;
const REGROW_FACTOR = 1.5;
const REGROW_MIN = 10;
const QUIET_MS = 2 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;
const GAP_MS = 1500;                       // between two completions
const CHEAP_MODELS = ['anthropic/claude-haiku-5-5', 'claude-cli/claude-haiku-5-5'];
const MODEL_RECHECK_MS = 6 * 60 * 60 * 1000; // a refused model is tried again after this
const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 3 * 60 * 60_000, 24 * 60 * 60_000];
const backoffMs = attempts => BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_MS.length - 1)];
const LIFECYCLE_RETRY_MS = 30_000;
// A failure worth retrying later on the same cheap model (rather than moving the chat to a pricier
// one). Anything else on a cheap model (unknown to this gateway's catalog, no credentials, a runtime
// that can't run it) means it isn't usable here: the next candidate is tried.
const TRANSIENT_CODES = new Set(['LLM_COMPLETION_TIMEOUT', 'LLM_COMPLETION_ABORTED']);
const TRANSIENT = /rate.?limit|too many requests|\b429\b|overload|\b529\b|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|\b50[0234]\b|temporar|try again/i;
const PROBE_DELAY_MS = 15_000;
// The host refused because the plugin is reloading or stopping (LLM_RUNTIME_LIFECYCLE; 2026.11.6 also
// reports a retired runtime by message only): no inference ran, nothing is wrong with the model or chat.
const isLifecycle = e => e?.code === 'LLM_RUNTIME_LIFECYCLE' || /runtime is no longer active|runtime (has )?retired|plugin is reloading/i.test(e?.message || '');
const SAMPLE_COSTS = 20;                   // recent measured costs behind the backfill estimate

export class Tagger {
  /**
   * @param {object} o
   * @param {ReturnType<import('./store.js').createTagStore>} o.tags
   * @param {import('../search/store.js').SearchStore} o.search
   * @param {import('../search/indexer.js').SearchIndexer} o.indexer
   * @param {{ complete?: Function }} o.llm  api.runtime.llm
   * @param {() => (string | null | undefined)} [o.model]  the owner's tag model (config), read at each call
   * @param {() => Array<{ key, summary, keywords, messages, taggedAt }>} [o.legacy]  pre-gateway summaries
   * @param {(frame: object) => void} [o.notify]
   */
  constructor({ tags, search, indexer, llm, model = () => null, legacy = () => [], notify = () => {}, logger = console, now = () => Date.now(), quietMs = QUIET_MS, gapMs = GAP_MS, sweepMs = SWEEP_MS }) {
    Object.assign(this, { tags, search, indexer, llm, configuredModel: model, legacy, notify, log: logger, now, quietMs, gapMs, sweepMs });
    this.complete = typeof llm?.complete === 'function' ? createCompletion(llm, { systemPrompt: SYSTEM_PROMPT, purpose: 'clawchats.tags', maxTokens: 400 }) : null;
    this.timers = new Map();   // key -> debounce timer
    this.queue = new Set();
    this.forced = new Set();   // Re-tag asked by the user: runs regardless of the rules
    this.refused = new Map();  // model -> when the gateway refused it
    this.running = false;
    this.current = null;
    this.lastError = null;
    this.lastModel = this.tags.meta('model');
    this.closed = false;
    if (this.tags.meta('since') == null) this.tags.setMeta('since', this.now());
  }

  start() {
    this._onSynced = key => this._guard(() => this._changed(key));
    this._onRemoved = key => this._guard(() => { this._drop(key); if (this.tags.delete(key)) this.announce(key); });
    this._onReady = () => this._guard(() => this.sweep());
    this.indexer.on('synced', this._onSynced);
    this.indexer.on('removed', this._onRemoved);
    this.indexer.on('ready', this._onReady);
    this.interval = setInterval(() => this._guard(() => this.sweep()), this.sweepMs);
    this.interval.unref?.();
    this._guard(() => { this._copyAllToIndex(); this.sweep(); });
    if (!this.lastModel) { this._probeTimer = setTimeout(() => this.probe().catch(() => {}), PROBE_DELAY_MS); this._probeTimer.unref?.(); }
  }

  /**
   * Which model tags on this gateway, found once with a tiny completion (a refused override costs
   * nothing; an allowed one a few tokens), so Settings and the backfill offer name the right model
   * and price before the first chat is tagged.
   */
  async probe() {
    if (this.lastModel || !this.enabled || !this.complete || this.closed) return;
    try {
      const { result, model } = await this._complete('Reply with {}');
      const used = result?.provider && result?.model ? `${result.provider}/${result.model}` : model;
      if (used && !this.lastModel) { this.lastModel = used; this.tags.setMeta('model', used); this._status(); }
    } catch (e) { this.log.info?.(`[tags] model check: ${e?.code || e?.message}`); }
  }

  close() {
    this.closed = true;
    clearInterval(this.interval);
    clearTimeout(this._probeTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.queue.clear();
    this.indexer.off('synced', this._onSynced);
    this.indexer.off('removed', this._onRemoved);
    this.indexer.off('ready', this._onReady);
  }

  _guard(fn) { try { return fn(); } catch (e) { this.log.warn?.(`[tags] ${e.message}`); } }

  get enabled() { return this.tags.meta('enabled') !== '0'; }

  /** 'accepted' | 'declined' | null (not asked yet) */
  get backfill() { return this.tags.meta('backfill'); }

  setEnabled(on) {
    this.tags.setMeta('enabled', on ? '1' : '0');
    if (on) this.sweep(); else { this.queue.clear(); for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
    this._status();
  }

  setBackfill(answer) {
    this.tags.setMeta('backfill', answer === 'accepted' ? 'accepted' : 'declined');
    if (answer === 'accepted') this.sweep();
    else for (const key of [...this.queue]) if (!this.forced.has(key) && this._isHistory(key)) this.queue.delete(key);
    this._status();
  }

  // ── When ──────────────────────────────────────────────────────────

  /** The index caught up with a chat: copy its tags over (new chat, or after a Rebuild), and tag it once it has been quiet. */
  _changed(key) {
    const row = this.tags.get(key);
    if (row && !this.search.hasMeta(key)) this._copyToIndex(key, row);
    if (!this.enabled || this.closed) return;
    clearTimeout(this.timers.get(key));
    const t = setTimeout(() => { this.timers.delete(key); this._guard(() => { if (this._due(key)) { this.queue.add(key); this._drain(); } }); }, this.quietMs);
    t.unref?.();
    this.timers.set(key, t);
  }

  _isHistory(key) {
    const chat = this.search.getChat(key);
    return !chat || chat.stamp <= Number(this.tags.meta('since'));
  }

  /** Whether a chat should be tagged (again) now. */
  _due(key, row = this.tags.get(key), count = this.search.messageCount(key)) {
    if (!this.search.getChat(key) || count < MIN_MESSAGES) return false;
    if (row?.error && this.now() - row.errorAt < backoffMs(row.attempts)) return false;
    if (row?.source !== 'auto') return this.backfill === 'accepted' || !this._isHistory(key);
    return count >= Math.max(row.messages * REGROW_FACTOR, row.messages + REGROW_MIN);
  }

  /** Queue every chat that's due (start, every SWEEP_MS, after enabling or accepting the backfill). */
  sweep() {
    if (this.closed) return;
    // Housekeeping once the index has the whole roster: old summaries in, rows of deleted chats out.
    if (this.search.completedAt != null) { this._importLegacy(); this._prune(); }
    if (!this.enabled) return;
    const rows = new Map(this.tags.all().map(r => [r.key, r]));
    for (const c of this.search.taggable(MIN_MESSAGES)) if (this._due(c.key, rows.get(c.key), c.messages)) this.queue.add(c.key);
    this._drain();
  }

  /** Re-tag one chat now (the user asked). */
  retag(key) {
    if (!this.search.getChat(key)) throw Object.assign(new Error('That chat isn\'t in the search index yet'), { status: 409 });
    if (!this.complete) throw Object.assign(new Error('This OpenClaw version has no plugin model completion'), { status: 501 });
    this.forced.add(key);
    this.queue.delete(key);
    this.queue = new Set([key, ...this.queue]); // ahead of the backlog
    this._drain();
  }

  _drop(key) { clearTimeout(this.timers.get(key)); this.timers.delete(key); this.queue.delete(key); this.forced.delete(key); }

  // ── Work ──────────────────────────────────────────────────────────

  _drain() {
    if (this.running || this.closed || !this.complete) return this.draining;
    this.draining = this._drainLoop();
    return this.draining;
  }

  async _drainLoop() {
    this.running = true;
    try {
      while (this.queue.size && !this.closed) {
        const key = this.queue.values().next().value;
        this.queue.delete(key);
        const forced = this.forced.delete(key);
        if (!forced && (!this.enabled || !this._due(key))) continue;
        this.current = key;
        this._status();
        try { await this.tagChat(key); }
        catch (e) {
          if (this.closed) break; // stopped mid-call (plugin reload): the next instance tags it
          if (isLifecycle(e)) { // the gateway is reloading: no inference ran, try later
            const t = setTimeout(() => { this.timers.delete(key); this.queue.add(key); this._drain(); }, LIFECYCLE_RETRY_MS);
            t.unref?.();
            this.timers.set(key, t);
            break;
          }
          this.lastError = { key, message: e.message, at: this.now() };
          if (this.search.getChat(key)) this.tags.markFailed(key, e.message);
          this.log.warn?.(`[tags] ${key}: ${e.message}`);
        }
        this.current = null;
        this._status();
        if (this.queue.size) await new Promise(r => setTimeout(r, this.gapMs));
      }
    } finally {
      this.running = false;
      this.current = null;
      this._status();
    }
  }

  /** Tag one chat: its text from the index → the model → tag store → index. */
  async tagChat(key) {
    const chat = this.search.getChat(key);
    if (!chat) return null;
    const messages = this.search.messages(key);
    const count = messages.filter(m => m.kind === 'message').length;
    const vocabulary = this.tags.vocabulary().map(v => v.tag);
    const prompt = buildPrompt({ title: chat.title, conversation: condense(messages), vocabulary });
    const { result, model } = await this._complete(prompt);
    if (this.closed) return null; // stopped while the model was answering
    const parsed = parseReply(result?.text, { vocabulary: new Set(vocabulary), aliases: this.tags.aliases() });
    if (!this.search.getChat(key)) return null; // deleted while the model was answering
    const usedModel = result?.provider && result?.model ? `${result.provider}/${result.model}` : model;
    if (usedModel && usedModel !== this.lastModel) this.tags.setMeta('model', usedModel);
    this.lastModel = usedModel;
    this.lastError = null;
    const row = this.tags.saveAuto(key, { ...parsed, model: usedModel, messages: count, costUsd: result?.usage?.costUsd ?? null });
    this._copyToIndex(key, row);
    this.announce(key, row);
    return row;
  }

  /** The owner's tag model when one is configured, else the cheap models: asked for in this order. */
  _candidates() {
    let chosen = null;
    try { chosen = this.configuredModel(); } catch { /* config unreadable: the built-in choice */ }
    chosen = typeof chosen === 'string' ? chosen.trim() : '';
    return chosen ? [chosen] : CHEAP_MODELS;
  }

  /** The completion on the first candidate the gateway allows, else on its default model. */
  async _complete(prompt) {
    const candidates = this._candidates();
    for (const model of candidates) {
      if (this._refused(model)) continue;
      try {
        const result = await this.complete(prompt, { model });
        // Every credential for it failed (the host resolves rather than throws): not usable here.
        if (result?.stopReason === 'error') throw new Error(result.errorMessage || 'provider error');
        return { result, model };
      } catch (e) {
        if (isLifecycle(e) || TRANSIENT_CODES.has(e?.code) || TRANSIENT.test(e?.message || '')) throw e; // retried later, same model
        // No override permission: refused before any inference, for every model.
        if (e?.code === 'LLM_COMPLETION_NOT_AUTHORIZED') { for (const m of candidates) this.refused.set(m, this.now()); }
        else this.refused.set(model, this.now());
        this.log.info?.(`[tags] ${model} unavailable here (${e?.code || e?.message}); trying the next`);
      }
    }
    const result = await this.complete(prompt);
    if (result?.stopReason === 'error') throw new Error(result.errorMessage || 'the model returned an error');
    return { result, model: null };
  }

  _refused(model) {
    const at = this.refused.get(model);
    return at != null && this.now() - at < MODEL_RECHECK_MS;
  }

  // ── Index copy ────────────────────────────────────────────────────

  _copyToIndex(key, row) {
    if (row) this.search.setMeta(key, { tags: row.tags, summary: row.summary, keywords: row.keywords });
  }

  _copyAllToIndex() { for (const row of this.tags.all()) this._copyToIndex(row.key, row); }

  /** The pre-gateway ClawChats summaries (once): searchable right away, tagged like history. */
  _importLegacy() {
    if (this.tags.meta('legacy_imported')) return;
    const rows = (this.legacy() || []).filter(r => this.search.getChat(r.key));
    const n = rows.length ? this.tags.importLegacy(rows) : 0;
    this.tags.setMeta('legacy_imported', this.now());
    if (n) { this.log.info?.(`[tags] imported ${n} summaries from the old ClawChats databases`); this._copyAllToIndex(); }
  }

  /** Rows of chats the (complete) index no longer has: deleted while the connector wasn't running. */
  _prune() {
    const live = new Set(this.search.chatKeys());
    for (const key of this.tags.keys()) if (!live.has(key) && this.tags.delete(key)) this.announce(key);
  }

  // ── Status ────────────────────────────────────────────────────────

  /** Tell browsers a chat's tags changed. */
  announce(key, row = this.tags.get(key)) {
    try { this.notify({ type: 'clawchats', event: 'tags', key, tags: row?.tags || [], summary: row?.summary || '' }); } catch { /* no browsers */ }
    this._status();
  }

  _status() {
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => { try { this.notify({ type: 'clawchats', event: 'tags-status', status: this.status() }); } catch { /* no browsers */ } }, 500);
    this._statusTimer.unref?.();
  }

  /** For Settings and the backfill offer. */
  status() {
    const rows = new Map(this.tags.all().map(r => [r.key, r]));
    const taggable = this.search.taggable(MIN_MESSAGES);
    let tagged = 0, failed = 0;
    const history = [];
    for (const c of taggable) {
      const r = rows.get(c.key);
      if (r?.source === 'auto') tagged++;
      else if (this._isHistory(c.key)) history.push(c);
      if (r?.error) failed++;
    }
    const costs = [...rows.values()].filter(r => r.source === 'auto' && r.costUsd != null).sort((a, b) => b.taggedAt - a.taggedAt).slice(0, SAMPLE_COSTS);
    const candidates = this._candidates();
    const cheapModelRefused = candidates.every(m => this._refused(m));
    const model = this.lastModel || (cheapModelRefused ? null : candidates[0]);
    const costUsd = isSubscription(model) ? null : costs.length >= 3 ? costs.reduce((n, r) => n + r.costUsd, 0) / costs.length * history.length : estimateCost(history.map(c => c.chars || 0), model);
    return {
      enabled: this.enabled, available: !!this.complete,
      model: this.lastModel, requestedModel: candidates[0], cheapModelRefused, subscription: isSubscription(model),
      tagged, failed, waiting: this.queue.size, working: this.current,
      lastError: this.lastError,
      backfill: { state: this.backfill, chats: history.length, costUsd: costUsd == null ? null : Math.round(costUsd * 100) / 100 },
    };
  }
}
