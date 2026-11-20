// Lost Allows (OpenClaw bug, seen on 2026.9.7 and 2026.11.6, known-gaps/approval-wait-access-revision.md in the
// clawchats repo; not reported upstream): any session create/delete/spawn bumps the gateway-wide access revision
// (src/gateway/server-methods/session-change-event.ts emitSessionsChanged), and every exec approval still waiting
// then fails its wait once decided (approval-request-authority.ts assertPolicyCurrent: "Approval requester authority
// changed"). The user's Allow is recorded, but the agent gets "Exec denied (gateway id=…, approval-request-failed)"
// and the command never runs. The agent's wait is the gateway's own call, so it can't be repeated from here.
//
// Workaround: after a user's Allow, the session's transcript is checked for that failure. If it is there, the
// decision is kept for that exact command (same session, command text, host, node, cwd) for a short time and used
// once: once the run has replied, the agent is asked to run it again, and its new approval gets the kept decision.
// Nothing the user didn't allow is ever approved: a different command, session or a second request still asks.
// Runs started anywhere (ClawChats, channels, subagents) are covered: their tool events don't reach this
// connection, the approval events and the transcript do.

export const LOST_ALLOW_RE = /^Exec denied \((?:gateway|node=\S+) id=([^,)\s]+), approval-request-failed\)/;
const ALLOW = new Set(['allow-once', 'allow-always']);
const KEEP_MS = 120_000;                    // how long a lost Allow waits for the agent's rerun
const CHECKS_MS = [1500, 4000, 10_000];     // transcript checks after an Allow (the failure lands right after it)
const REPLY_WAIT_MS = 30_000;               // ask for the rerun after this even if the run hasn't replied

const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
const textOf = content => typeof content === 'string' ? content
  : (Array.isArray(content) ? content : []).filter(c => c?.type === 'text').map(c => c.text).join('\n');

export class LostAllowRetry {
  /**
   * @param {object} o
   * @param {(method: string, params?: object, timeoutMs?: number) => Promise<any>} o.request  the connector's own gateway RPC
   */
  constructor({ request, keepMs = KEEP_MS, checksMs = CHECKS_MS, replyWaitMs = REPLY_WAIT_MS, pollMs = 1500, now = Date.now, log = console }) {
    this.request = request;
    this.keepMs = keepMs;
    this.checksMs = checksMs;
    this.replyWaitMs = replyWaitMs;
    this.pollMs = pollMs;
    this.now = now;
    this.log = log;
    this._kept = [];        // { approvalId, sessionKey, command, host, nodeId, cwd, decision, expiresAt, used }
    this._seen = new Set(); // allowed approval ids already checked
  }

  /** Approval events (approval-client connection). */
  onApprovalEvent(msg) {
    const p = msg?.payload || {};
    if (msg?.event === 'exec.approval.resolved' && ALLOW.has(p.decision) && p.id && !this._seen.has(p.id)) {
      this._seen.add(p.id);
      if (this._seen.size > 500) this._seen = new Set([...this._seen].slice(-200));
      this._check(p.id).catch(e => this.log.warn?.(`[approvals] lost allow check ${p.id}: ${e.message}`));
    } else if (msg?.event === 'exec.approval.requested') {
      this._rerun(p);
    }
  }

  /** An agent's rerun of a lost Allow gets the user's decision, once. */
  _rerun({ id, request: r = {} }) {
    this._prune();
    const k = this._kept.find(k => !k.used && k.sessionKey === r.sessionKey && k.command === r.command
      && k.host === (r.host ?? null) && k.nodeId === (r.nodeId ?? null) && (k.cwd === null || k.cwd === (r.cwd ?? null)));
    if (!k || !id) return;
    const allowed = Array.isArray(r.allowedDecisions) ? r.allowedDecisions : [...ALLOW];
    const decision = allowed.includes(k.decision) ? k.decision : allowed.includes('allow-once') ? 'allow-once' : null;
    if (!decision) return;
    k.used = true;
    this.log.log?.(`[approvals] lost allow ${k.approvalId}: rerun ${id} resolved ${decision} (the user's earlier decision)`);
    this.request('exec.approval.resolve', { id, decision }, 15_000)
      .catch(e => this.log.warn?.(`[approvals] resolving rerun ${id}: ${e.message}`));
  }

  /** The transcript entry where the agent's exec of `approvalId` came back approval-request-failed (index), or -1. */
  _failureIn(messages, approvalId) {
    return messages.findIndex(m => m?.role === 'toolResult' && LOST_ALLOW_RE.exec(textOf(m.content))?.[1] === approvalId);
  }

  async _history(sessionKey) {
    return (await this.request('chat.history', { sessionKey, limit: 30 }, 15_000))?.messages || [];
  }

  async _check(approvalId) {
    // Only a user's Allow is kept; the record also gives the session and the exact command.
    const items = (await this.request('approval.history', { limit: 50 }, 15_000))?.items || [];
    const rec = items.find(i => i.id === approvalId);
    const pr = rec?.presentation || {};
    const sessionKey = rec?.source?.sessionKey;
    if (rec?.status !== 'allowed' || rec.reason !== 'user' || !ALLOW.has(rec.decision) || pr.kind !== 'exec' || !pr.commandText || !sessionKey) return;
    let messages = [];
    let at = -1;
    let waited = 0;
    for (const ms of this.checksMs) {
      await sleep(ms - waited);
      waited = ms;
      messages = await this._history(sessionKey);
      at = this._failureIn(messages, approvalId);
      if (at >= 0) break;
    }
    if (at < 0) return; // the command ran (or failed some other way)
    const details = messages[at].details || {};
    const kept = { approvalId, sessionKey, command: pr.commandText, host: pr.host ?? null, nodeId: pr.nodeId ?? null,
      cwd: typeof details.cwd === 'string' ? details.cwd : null, decision: rec.decision, expiresAt: this.now() + this.keepMs, used: false };
    this._kept.push(kept);
    this.log.log?.(`[approvals] lost allow ${approvalId} (${rec.decision}) in ${sessionKey}: asking the agent to rerun`);
    // Ask once the run has replied after the failure: an agent that retries on its own uses the kept Allow, and then
    // no note is sent.
    const end = this.now() + this.replyWaitMs;
    while (!kept.used && this.now() < end) {
      const i = this._failureIn(messages, approvalId);
      if (i >= 0 && messages.slice(i + 1).some(m => m?.role === 'assistant' && textOf(m.content).trim())) break;
      await sleep(this.pollMs);
      messages = await this._history(sessionKey).catch(() => messages);
    }
    if (kept.used || this.now() > kept.expiresAt) return;
    await this.request('chat.send', {
      sessionKey, deliver: false, idempotencyKey: `cc-lost-allow-${approvalId}`,
      message: `[ClawChats] The command you just ran was allowed, but the gateway lost the approval before it ran (OpenClaw bug: a session changed while it waited). Run exactly the same command again; the user's Allow will be applied to it:\n${pr.commandText}`,
    }, 30_000);
  }

  _prune() {
    const t = this.now();
    this._kept = this._kept.filter(k => !k.used && k.expiresAt >= t);
  }
}
