// Push notifications to the owner's devices, sent by the connector from the gateway events it already receives:
// approvals, agent questions, replies in sidebar chats, failed automations. Nothing is pushed while the owner is
// at a ClawChats window (presence.js), except an approval still waiting after 2 minutes.
//
// Every device gets its own encrypted message (web-push.js); the signal server only signs VAPID tokens (vapid.js).
// Tags: `chat-<sessionKey>` per chat (the in-tab desktop notification uses the same, frontend/ui/notifications.js),
// `approval-<id>`, `question-<id>`, `cron-<jobId>`. A later push with the same tag replaces the earlier one.
import fs from 'node:fs';
import { postPush, pushAudience, isApplePush, encryptPayload, topicFor } from './web-push.js';

export const APPROVAL_ESCALATE_MS = 2 * 60_000;
const RENOTIFY_AFTER_MS = 30_000;
const MAX_PAYLOAD = 3000;
const BODY_MAX = 150;
const REPLY_TTL = 24 * 3600;
const EVENT_TTL = 3600;
const RETRIES = 3;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const AGENTS_TTL_MS = 10 * 60_000;
const APPROVAL_EVENT = /^(exec|plugin|openclaw)\.approval\.(requested|resolved)$/;
const APPROVAL_KIND = { exec: 'exec', plugin: 'plugin', openclaw: 'system-agent' };
const DECISION_LABEL = { 'allow-once': 'Allowed once', 'allow-always': 'Always allowed', deny: 'Denied' };

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };

/** Markdown to one line of plain text (notification bodies are plain). */
export function plainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')                 // code blocks
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')           // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // links
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The reply text of a final chat message: its text after the last tool call (claude-cli sends the whole run). */
export function replyText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return typeof message.text === 'string' ? message.text : '';
  let last = -1;
  content.forEach((b, i) => { if (b && /tool/.test(b.type || '')) last = i; });
  return content.slice(last + 1).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

// Plugin status lines the gateway sends as their own chat final when verbose status is on (Active Memory's
// "🧩 Active Memory: status=…", memory search): not a reply, so they neither count nor become the preview.
const STATUS_LINE = /^(?:🧩|🔎|🧠)?\s*(?:active memory(?: debug)?|memory search):/i;
export const isStatusOnly = text => text.split('\n').every(l => !l.trim() || STATUS_LINE.test(l.trim()));

const nativeToolCommand = text => {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return null;
  try { const v = JSON.parse(text); return typeof v?.command === 'string' ? v.command : null; } catch { return null; }
};

export class PushNotifier {
  /**
   * @param {object} o
   * @param {import('./store.js').PushStore} o.store
   * @param {import('./presence.js').Presence} o.presence
   * @param {import('./vapid.js').VapidTokens} o.vapid
   * @param {{ isTopLevel(key: string): boolean }} o.lens   which sessions are sidebar chats
   * @param {(method: string, params: object) => Promise<any>} [o.request]  gateway RPC (agent names)
   * @param {() => string} [o.gatewayId]
   * @param {() => string} [o.gatewayName]
   */
  constructor({ store, presence, vapid, lens, request, gatewayId = () => '', gatewayName = () => '', post = postPush, escalateMs = APPROVAL_ESCALATE_MS, now = Date.now, log = console, timers = globalThis, stateFile = null }) {
    Object.assign(this, { store, presence, vapid, lens, request, gatewayId, gatewayName, post, escalateMs, now, log, timers, stateFile });
    this.rows = new Map();       // session key -> { title, unread, incognito }
    this.replies = new Map();    // session key -> { count, lastBuzzAt } since the chat was last read
    this.pending = new Map();    // `approval-<id>` / `question-<id>` -> { kind, item, pushed: Set<deviceId>, timers }
    this._agents = null;
    this._loadState();
  }

  // ── What the connector learns about chats (SessionLens rows and events) ──

  /** A (possibly partial) session row: title, unread and incognito for notifications and the badge. */
  noteRow(key, row) {
    if (!key || !row || typeof row !== 'object') return;
    const r = this.rows.get(key) || { title: null, unread: false, incognito: false };
    const t = row.label || row.displayName || row.derivedTitle || row.autoLabel;
    if (typeof t === 'string' && t.trim()) r.title = t.trim();
    if ('unread' in row) {
      r.unread = !!row.unread;
      if (!r.unread) this.replies.delete(key); // read somewhere: the next reply starts a new count
    }
    if ('incognito' in row) r.incognito = !!row.incognito;
    if (row.reason === 'delete') { this.rows.delete(key); this.replies.delete(key); return; }
    this.rows.set(key, r);
  }

  unreadCount() {
    let n = 0;
    for (const [key, r] of this.rows) if (r.unread && this.lens.isTopLevel(key)) n++;
    return n;
  }

  _chatTitle(key) { return (key && this.rows.get(key)?.title) || null; }

  async _agentName(agentId) {
    if (!agentId) return 'Your agent';
    if (this.request && (!this._agents || this.now() - this._agents.at > AGENTS_TTL_MS)) {
      try {
        const res = await this.request('agents.list', {});
        this._agents = { at: this.now(), names: new Map((res?.agents || []).map(a => [a.id, a.identity?.name || a.name || a.id])) };
      } catch { this._agents = { at: this.now(), names: this._agents?.names || new Map() }; }
    }
    return this._agents?.names.get(agentId) || agentId;
  }

  // ── Gateway events ──

  onGatewayEvent(msg) { this._run(this._gatewayEvent(msg)); }
  onApprovalEvent(msg) { this._run(this._approvalEvent(msg)); }
  _run(p) { p?.catch?.(e => this.log.warn?.(`[push] ${e.message}`)); }

  _gatewayEvent(msg) {
    const p = msg?.payload;
    if (!p || typeof p !== 'object') return;
    if (msg.event === 'chat' && p.state === 'final') return this._onReply(p);
    if (msg.event === 'question.requested') return this._onQuestion(p);
    if (msg.event === 'question.resolved') return this._settle(`question-${p.id}`, p.status === 'answered' ? 'Answered' : p.status === 'expired' ? 'Expired' : 'Handled');
    if (msg.event === 'cron' && p.action === 'finished' && p.status === 'error') return this._onCronFailed(p);
  }

  _approvalEvent(msg) {
    const m = APPROVAL_EVENT.exec(msg?.event || '');
    const p = msg?.payload;
    if (!m || !p?.id) return;
    if (m[2] === 'resolved') return this._settle(`approval-${p.id}`, DECISION_LABEL[p.decision] ? `Handled: ${DECISION_LABEL[p.decision]}` : 'Handled');
    return this._onApproval(APPROVAL_KIND[m[1]], p);
  }

  /** Presence changed: the owner left (or a window closed), so what waited on them goes out now. */
  presenceChanged() {
    if (this.presence.isPresent()) return;
    for (const [tag, e] of this.pending) if (e.item && !e.pushed.size) this._run(this._pushPending(tag, e));
  }

  async _onReply(p) {
    const key = p.sessionKey;
    if (!key || p.yielded === true || !this.lens.isTopLevel(key)) return;
    const raw = replyText(p.message);
    if (!raw.trim() || isStatusOnly(raw)) return;
    const text = plainText(raw);
    if (!text) return;
    if (this.presence.isPresent()) return;
    const r = this.replies.get(key) || { count: 0, lastBuzzAt: 0 };
    r.count++;
    const renotify = this.now() - r.lastBuzzAt > RENOTIFY_AFTER_MS;
    if (renotify) r.lastBuzzAt = this.now();
    this.replies.set(key, r);
    const chat = this._chatTitle(key) || await this._agentName(key.split(':')[1]);
    const preview = clip(text, BODY_MAX);
    const incognito = !!this.rows.get(key)?.incognito;
    await this._deliver('replies', {
      kind: 'reply', tag: `chat-${key}`, sessionKey: key, renotify, urgency: 'normal', ttl: REPLY_TTL,
      title: chat, body: r.count > 1 ? clip(`${r.count} new replies · ${preview}`, BODY_MAX) : preview,
      privateTitle: 'ClawChats', privateBody: r.count > 1 ? `${r.count} new replies in ${chat}` : `New reply in ${chat}`,
      forcePrivate: incognito,
    });
  }

  async _onApproval(kind, p) {
    const tag = `approval-${p.id}`;
    if (this.pending.has(tag) || !(p.expiresAtMs > this.now())) return;
    const slot = this._reserve(tag);
    const r = p.request || {};
    const sessionKey = r.sessionKey || null;
    const agent = await this._agentName(r.agentId || (sessionKey || '').split(':')[1]);
    const command = kind === 'exec' ? (r.command || r.commandText || r.detail) : nativeToolCommand(r.detail) || nativeToolCommand(r.description);
    const body = command ? `${agent} wants to run \`${clip(command, 100)}\`` : kind === 'plugin' ? `${agent}: ${clip(r.description || r.title, 120)}` : clip(r.title || 'Approval needed', 120);
    const chat = this._chatTitle(sessionKey);
    const item = {
      kind: 'approval', tag, sessionKey, approvalId: p.id, approvalKind: kind, expiresAtMs: p.expiresAtMs, urgency: 'high',
      ttl: Math.max(60, Math.ceil((p.expiresAtMs - this.now()) / 1000)), renotify: true,
      title: chat || agent, body, privateTitle: 'ClawChats', privateBody: chat ? `Approval needed in ${chat}` : 'Approval needed',
      // shown on the timed-out card when the app opens from an expired one
      approvalTitle: clip(kind === 'exec' ? 'Run command' : r.title || 'Approval', 80), approvalDetail: clip(command || r.description || '', 300),
    };
    this._track(tag, slot, 'approvals', item, true);
  }

  async _onQuestion(p) {
    const tag = `question-${p.id}`;
    if (this.pending.has(tag) || !p.id || !(p.expiresAtMs > this.now())) return;
    const slot = this._reserve(tag);
    const q = Array.isArray(p.questions) ? p.questions[0] : null;
    const agent = await this._agentName(p.agentId || (p.sessionKey || '').split(':')[1]);
    const chat = this._chatTitle(p.sessionKey);
    const item = {
      kind: 'question', tag, sessionKey: p.sessionKey || null, questionId: p.id, expiresAtMs: p.expiresAtMs, urgency: 'high',
      ttl: Math.max(60, Math.ceil((p.expiresAtMs - this.now()) / 1000)), renotify: true,
      title: chat || agent, body: clip(`${agent} asks: ${plainText(q?.question) || 'a question'}`, BODY_MAX),
      privateTitle: 'ClawChats', privateBody: chat ? `Question waiting in ${chat}` : 'An agent has a question',
    };
    this._track(tag, slot, 'questions', item, false);
  }

  /** Hold the tag while names load, so a repeated event or an early resolve can't race it. */
  _reserve(tag) {
    const slot = { pref: null, item: null, pushed: new Set(), timers: [] };
    this.pending.set(tag, slot);
    return slot;
  }

  /** An approval or question waiting on the owner: pushed now when away; approvals also after 2 minutes regardless. */
  _track(tag, slot, pref, item, escalate) {
    if (this.pending.get(tag) !== slot) return; // resolved while its names loaded
    const e = Object.assign(slot, { pref, item, escalateAt: escalate ? this.now() + this.escalateMs : null });
    this._arm(tag, e);
    this._saveState();
    if (!this.presence.isPresent()) return this._pushPending(tag, e);
  }

  /** Expiry and (approvals) escalation timers of a pending entry. */
  _arm(tag, e) {
    e.timers.push(this.timers.setTimeout(() => this._run(this._settle(tag, 'Expired')), Math.max(0, e.item.expiresAtMs - this.now())));
    if (e.escalateAt != null) e.timers.push(this.timers.setTimeout(() => { if (this.pending.get(tag) === e) this._run(this._pushPending(tag, e, { escalated: true })); }, Math.max(0, e.escalateAt - this.now())));
    for (const t of e.timers) t?.unref?.();
  }

  // Pending approvals/questions and the devices already told survive a connector restart (plugin reloads hand running
  // turns over): the new process neither pushes them again nor loses their Handled/Expired replacement or escalation.
  _saveState() {
    if (!this.stateFile) return;
    const pending = [...this.pending].filter(([, e]) => e.item).map(([tag, e]) => ({ tag, pref: e.pref, item: e.item, pushed: [...e.pushed], escalateAt: e.escalateAt }));
    try {
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pending }), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (err) { this.log.warn?.(`[push] could not save pending state: ${err.message}`); }
  }

  _loadState() {
    if (!this.stateFile) return;
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return; }
    for (const p of Array.isArray(saved?.pending) ? saved.pending : []) {
      if (!p?.tag || !p.item || !(p.item.expiresAtMs > this.now())) continue;
      const e = { pref: p.pref, item: p.item, pushed: new Set(p.pushed || []), timers: [], escalateAt: p.escalateAt ?? null };
      this.pending.set(p.tag, e);
      this._arm(p.tag, e);
    }
  }

  async _pushPending(tag, e, { escalated = false } = {}) {
    if (e.sending) return;
    e.sending = true;
    try {
      const sent = await this._deliver(e.pref, { ...e.item, escalated }, { skip: id => e.pushed.has(id) });
      for (const id of sent) e.pushed.add(id);
      if (sent.length) this._saveState();
    } finally { e.sending = false; }
  }

  /** Resolved elsewhere, answered or expired: devices that got the push see it replaced (same tag), except Apple's. */
  async _settle(tag, outcome) {
    const e = this.pending.get(tag);
    if (!e) return;
    this.pending.delete(tag);
    if (!e.item) return;
    for (const t of e.timers) this.timers.clearTimeout(t);
    this._saveState();
    if (!e.pushed.size) return;
    const { item } = e;
    await this._deliver(e.pref, {
      kind: `${item.kind}-done`, tag, sessionKey: item.sessionKey, approvalId: item.approvalId, questionId: item.questionId,
      approvalTitle: item.approvalTitle, approvalDetail: item.approvalDetail, expiresAtMs: item.expiresAtMs,
      title: item.title, body: `${outcome} · ${item.body}`, privateTitle: item.privateTitle, privateBody: `${outcome} · ${item.privateBody}`,
      urgency: 'low', ttl: 600, renotify: false, silent: true,
    }, { only: id => e.pushed.has(id), apple: false });
  }

  async _onCronFailed(p) {
    if (this.presence.isPresent()) return;
    const name = clip(p.job?.name || 'An automation', 60);
    const reason = clip(plainText(p.error || p.summary || ''), 100);
    await this._deliver('automationFailures', {
      kind: 'automation', tag: `cron-${p.jobId || 'failed'}`, jobId: p.jobId || null, runId: p.runId || null, urgency: 'normal', ttl: EVENT_TTL, renotify: true,
      title: 'Automation failed', body: reason ? `${name}: ${reason}` : `${name} failed.`,
      privateTitle: 'ClawChats', privateBody: 'An automation failed.',
    });
  }

  // ── Delivery ──

  /** Settings → Send test notification: this one device, now, whatever presence and its categories say. */
  async sendTest(deviceId) {
    const d = this.store.list().find(x => x.id === deviceId);
    if (!d) return false;
    return this._sendTo(d, this._payload(d, {
      kind: 'test', tag: 'clawchats-test', renotify: true, urgency: 'high', ttl: 120,
      title: 'ClawChats', body: `Test notification from ${clip(this.gatewayName(), 60) || 'your gateway'}. Notifications reach this device.`,
      privateTitle: 'ClawChats', privateBody: 'Test notification. Notifications reach this device.',
    }, this.unreadCount()), { kind: 'test', tag: 'clawchats-test', ttl: 120, urgency: 'high' });
  }

  /**
   * Send `n` to every device with `pref` on. Returns the ids of the devices it reached.
   * opts.skip / opts.only filter devices; opts.apple === false leaves out Apple's push service.
   */
  async _deliver(pref, n, { skip = () => false, only = () => true, apple = true } = {}) {
    const devices = this.store.list().filter(d => d.prefs[pref] && !skip(d.id) && only(d.id) && (apple || !isApplePush(d.endpoint)));
    if (!devices.length) return [];
    const unread = this.unreadCount();
    const reached = (await Promise.all(devices.map(d => this._sendTo(d, this._payload(d, n, unread), n).then(ok => ok && d.id)))).filter(Boolean);
    this.log.info?.(`[push] ${n.kind} → ${reached.length}/${devices.length} device(s)`); // no content, no endpoints
    return reached;
  }

  _payload(device, n, unread) {
    const priv = n.forcePrivate || !device.prefs.showPreviews;
    const out = {
      v: 1, kind: n.kind, tag: n.tag, gatewayId: this.gatewayId() || null, gatewayName: clip(this.gatewayName(), 60) || null,
      title: clip(priv ? n.privateTitle : n.title, 80), body: clip(priv ? n.privateBody : n.body, BODY_MAX + 40),
      renotify: !!n.renotify, unread, ts: this.now(),
    };
    for (const k of ['sessionKey', 'approvalId', 'approvalKind', 'questionId', 'jobId', 'runId', 'expiresAtMs', 'escalated', 'silent']) if (n[k] != null && n[k] !== false) out[k] = n[k];
    if (!priv && n.approvalTitle) { out.approvalTitle = n.approvalTitle; out.approvalDetail = n.approvalDetail; }
    return out;
  }

  /** One device: encrypt, POST, and act on the push service's answer. */
  async _sendTo(device, payload, n) {
    const audience = pushAudience(device.endpoint);
    if (!audience) { this.store.remove(device.id); return false; }
    let json = JSON.stringify(payload);
    if (json.length > MAX_PAYLOAD) json = JSON.stringify(shrink(payload));
    const topic = topicFor(n.tag);
    let refreshed = false, shrunk = false, unanswered = 0;
    for (let attempt = 0; ; attempt++) {
      let token;
      try { token = await this.vapid.get(audience); }
      catch (e) { this.log.warn?.(`[push] no VAPID token for ${audience}: ${e.message}`); return false; }
      const res = await this.post(device.endpoint, encryptPayload(device.keys, json), { jwt: token.jwt, publicKey: token.publicKey, ttl: n.ttl, urgency: n.urgency, topic });
      if (res.status >= 200 && res.status < 300) return true;
      if (res.status === 404 || res.status === 410) {
        this.log.info?.(`[push] "${device.deviceLabel}" unsubscribed at the push service (${res.status}); removed`);
        this.store.remove(device.id);
        return false;
      }
      if (res.status === 413 && !shrunk) { shrunk = true; json = JSON.stringify(shrink(payload)); continue; }
      if ((res.status === 401 || res.status === 403) && !refreshed) { refreshed = true; this.vapid.drop(audience); continue; }
      // No answer (timeout, reset): the push service may have taken it. One more try at most, same Topic (replaces
      // it if still queued) and without renotify (if both arrive, the second replaces the first under the same tag).
      if (res.status === 0 && unanswered++ === 0 && payload.renotify) json = JSON.stringify({ ...JSON.parse(json), renotify: false });
      const retryable = (res.status === 0 && unanswered === 1) || res.status === 429 || res.status >= 500;
      const delay = res.retryAfterMs ?? 1000 * 2 ** attempt;
      if (!retryable || attempt + 1 >= RETRIES || delay > Math.min(MAX_RETRY_DELAY_MS, n.ttl * 1000)) {
        this.log.warn?.(`[push] delivery to "${device.deviceLabel}" failed (${res.status || 'network error'})`);
        return false;
      }
      await new Promise(r => { const t = this.timers.setTimeout(r, delay); t?.unref?.(); });
    }
  }
}

/** The smallest useful payload (413 Payload Too Large): routing fields and a short body. */
function shrink(p) {
  const out = { ...p, title: clip(p.title, 40), body: clip(p.body, 60) };
  delete out.approvalTitle; delete out.approvalDetail; delete out.gatewayName;
  return out;
}
