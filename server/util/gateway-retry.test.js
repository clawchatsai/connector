import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestWithRetry, withGatewayRetry, isRetryableRefusal } from './gateway-retry.js';

const refusal = (extra = {}) => Object.assign(new Error('chat.send unavailable during gateway startup'), {
  gatewayCode: 'UNAVAILABLE', retryable: true, retryAfterMs: 500, details: { reason: 'startup-sidecars', method: 'chat.send' }, ...extra,
});

/** A request that fails with `errors` in turn, then answers. Records the sleeps. */
function scripted(errors, answer = { ok: true }) {
  const calls = [];
  const sleeps = [];
  const request = async (method, params, t) => { calls.push({ method, params, t }); const e = errors[calls.length - 1]; if (e) throw e; return answer; };
  return { request, calls, sleeps, sleep: async ms => { sleeps.push(ms); } };
}

test('a startup refusal is retried after retryAfterMs, then the answer comes back', async () => {
  const s = scripted([refusal(), refusal({ retryAfterMs: 1200 })]);
  const res = await requestWithRetry(s.request, 'sessions.create', { key: 'k' }, 7000, { sleep: s.sleep });
  assert.deepEqual(res, { ok: true });
  assert.equal(s.calls.length, 3);
  assert.deepEqual(s.calls.map(c => c.params), [{ key: 'k' }, { key: 'k' }, { key: 'k' }]); // same request each time
  assert.equal(s.calls[0].t, 7000);
  assert.deepEqual(s.sleeps, [500, 1200]);
});

test('the wait is bounded: delays are clamped, and the last refusal is thrown once ~60 s are used up', async () => {
  const s = scripted(Array.from({ length: 1000 }, () => refusal({ retryAfterMs: 60_000 })));
  const err = await requestWithRetry(s.request, 'chat.send', {}, 1000, { sleep: s.sleep }).catch(e => e);
  assert.equal(err.gatewayCode, 'UNAVAILABLE');
  assert.ok(s.sleeps.every(ms => ms === 2000)); // retryAfterMs clamped to 2 s
  assert.equal(s.sleeps.reduce((a, b) => a + b, 0), 60_000);
  assert.equal(s.calls.length, 31);
  const s2 = scripted(Array.from({ length: 10 }, () => refusal({ retryAfterMs: undefined })));
  await requestWithRetry(s2.request, 'chat.send', {}, 1000, { sleep: s2.sleep });
  assert.deepEqual(s2.sleeps, Array(10).fill(500)); // no hint: the gateway's default
  const s3 = scripted(Array.from({ length: 10 }, () => refusal({ retryAfterMs: 5 })));
  await requestWithRetry(s3.request, 'chat.send', {}, 1000, { sleep: s3.sleep });
  assert.ok(s3.sleeps.every(ms => ms === 100));
});

test('other errors are not retried: plain failures, non-retryable UNAVAILABLE, persisted config writes, restarts', async () => {
  const cases = [
    ['chat.send', new Error('boom')],
    ['chat.send', Object.assign(new Error('x'), { gatewayCode: 'INVALID_REQUEST', retryable: true })],
    ['chat.send', Object.assign(new Error('x'), { gatewayCode: 'UNAVAILABLE' })], // retryable missing
    ['config.patch', Object.assign(new Error('persisted'), { gatewayCode: 'UNAVAILABLE', details: { persistedConfig: {} } })],
    ['chat.send', refusal({ details: { reason: 'gateway-restarting' } })],
    ['chat.send', refusal({ details: { reason: 'goal-session-busy' } })],
    ['config.patch', Object.assign(new Error('x'), { gatewayCode: 'UNAVAILABLE', retryable: true, details: { reason: 'something-else' } })], // not an admission refusal, not chat.send
  ];
  for (const [method, error] of cases) {
    const s = scripted([error]);
    const err = await requestWithRetry(s.request, method, {}, 1000, { sleep: s.sleep }).catch(e => e);
    assert.equal(err, error);
    assert.equal(s.calls.length, 1, `${method}: ${error.message}`);
  }
});

test('chat.send is also retried for its other retryable refusals (same idempotencyKey, so it can not send twice)', async () => {
  const admitting = Object.assign(new Error('Chat input is being admitted; retry the same request.'), { gatewayCode: 'UNAVAILABLE', retryable: true });
  const rebuilding = Object.assign(new Error('session transcript is rebuilding; retry shortly'), { gatewayCode: 'UNAVAILABLE', retryable: true, retryAfterMs: 250, details: { method: 'chat.send' } });
  const s = scripted([admitting, rebuilding]);
  await requestWithRetry(s.request, 'chat.send', { idempotencyKey: 'r1' }, 1000, { sleep: s.sleep });
  assert.deepEqual(s.sleeps, [500, 250]);
  assert.ok(s.calls.every(c => c.params.idempotencyKey === 'r1'));
  assert.equal(isRetryableRefusal('sessions.patch', admitting), false); // only chat.send carries an idempotency key
  // An agent DB still being inspected refuses before any work, for every method.
  const dbPending = Object.assign(new Error('agent database inspection pending'), { gatewayCode: 'UNAVAILABLE', retryable: true, retryAfterMs: 250, details: { code: 'agent-database-inspection-pending' } });
  assert.equal(isRetryableRefusal('sessions.create', dbPending), true);
});

test('withGatewayRetry keeps the request signature and passes a healthy gateway through untouched', async () => {
  const seen = [];
  const request = withGatewayRetry(async (m, p, t) => { seen.push([m, p, t]); return { m }; });
  assert.deepEqual(await request('agents.list', {}, 5000), { m: 'agents.list' });
  assert.deepEqual(seen, [['agents.list', {}, 5000]]);
});
