// Retry for the connector's OWN gateway requests (team chat, sharing, guest agents, the session lens), never for
// frames a browser relays (the frontend retries those itself).
//
// 2026.11.4+ refuses write RPCs (chat.send, sessions.create/patch/send, agent, ...) with a retryable error while the
// gateway is starting or its agent DB is preparing: { code: 'UNAVAILABLE', retryable: true, retryAfterMs,
// details: { reason: 'startup-sidecars' } }. chat.send also answers retryable UNAVAILABLE while the same request is
// being admitted, the transcript rebuilds, or the model catalog races. Older gateways never send these, so the
// wrapper is a pass-through there. gateway.js request() keeps the error fields (gatewayCode, retryable, ...).

const MAX_TOTAL_MS = 60_000;     // cap on time spent waiting between attempts
const MIN_DELAY_MS = 100;
const MAX_DELAY_MS = 2_000;      // same bounds as the gateway's own client
const DEFAULT_DELAY_MS = 500;
// Retryable refusals a retry makes worse or cannot fix: the socket drops on a restart anyway; a busy goal needs the user.
const NEVER_RETRY_REASONS = new Set(['gateway-restarting', 'goal-session-busy']);

const wait = ms => new Promise(r => setTimeout(r, ms));

/** The refusal that happens before the method does any work (safe to repeat for every method). */
export function isAdmissionRefusal(e) {
  if (e?.gatewayCode !== 'UNAVAILABLE' || e.retryable !== true) return false;
  return e.details?.reason === 'startup-sidecars' || e.details?.code === 'agent-database-inspection-pending';
}

/** Whether `method` failing with `e` is worth repeating unchanged. */
export function isRetryableRefusal(method, e) {
  if (e?.gatewayCode !== 'UNAVAILABLE' || e.retryable !== true) return false;
  if (NEVER_RETRY_REASONS.has(e.details?.reason)) return false;
  if (isAdmissionRefusal(e)) return true;
  // chat.send carries an idempotencyKey, so repeating it can't send twice ("retry the same request").
  return method === 'chat.send';
}

function retryDelay(e) {
  const ms = Number.isFinite(e.retryAfterMs) ? Math.floor(e.retryAfterMs) : DEFAULT_DELAY_MS;
  return Math.min(Math.max(ms, MIN_DELAY_MS), MAX_DELAY_MS);
}

/**
 * Call `request(method, params, timeoutMs)`, repeating it after a retryable refusal, after the gateway's retryAfterMs,
 * until `maxMs` of waiting is used up; then the last refusal is thrown. Other errors pass straight through.
 */
export async function requestWithRetry(request, method, params, timeoutMs, { maxMs = MAX_TOTAL_MS, sleep = wait } = {}) {
  let waited = 0;
  for (;;) {
    try { return await request(method, params, timeoutMs); }
    catch (e) {
      if (!isRetryableRefusal(method, e)) throw e;
      const delay = retryDelay(e);
      if (waited + delay > maxMs) throw e;
      waited += delay;
      await sleep(delay);
    }
  }
}

/** `request` with the retry above; same signature. */
export const withGatewayRetry = (request, opts) => (method, params, timeoutMs) => requestWithRetry(request, method, params, timeoutMs, opts);
