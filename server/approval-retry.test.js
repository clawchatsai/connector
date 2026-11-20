import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LostAllowRetry, LOST_ALLOW_RE } from './approval-retry.js';

const SK = 'agent:main:chat-1';
const CWD = '/home/u/.openclaw/workspace';
const quiet = { log() {}, warn() {} };
const settle = () => new Promise(r => setTimeout(r, 30));

function historyItem(over = {}) {
  return {
    id: 'a1', status: 'allowed', reason: 'user', decision: 'allow-once',
    presentation: { kind: 'exec', commandText: 'touch /tmp/x', host: 'gateway', nodeId: null },
    source: { agentId: 'main', sessionKey: SK }, ...over,
  };
}
const user = { role: 'user', content: 'run touch /tmp/x' };
const failedResult = (id = 'a1', reason = 'approval-request-failed') => ({
  role: 'toolResult', toolName: 'exec', isError: true, details: { cwd: CWD },
  content: [{ type: 'text', text: `Exec denied (gateway id=${id}, ${reason}): touch /tmp/x\nCommand did not run: approval request failed.` }],
});
const reply = { role: 'assistant', content: [{ type: 'text', text: 'failed: approval request failed' }] };

/** transcript: the chat.history messages, or a function of the call count. */
function setup({ items = [historyItem()], transcript = [user, failedResult(), reply], ...opts } = {}) {
  const calls = [];
  let reads = 0;
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'approval.history') return { items };
    if (method === 'chat.history') return { messages: typeof transcript === 'function' ? transcript(reads++) : transcript };
    return {};
  };
  const r = new LostAllowRetry({ request, log: quiet, checksMs: [0, 5], replyWaitMs: 200, ...opts });
  return { r, calls, sent: m => calls.filter(c => c.method === m) };
}

const allowed = (id = 'a1', decision = 'allow-once') => ({ type: 'event', event: 'exec.approval.resolved', payload: { id, decision } });
const rerun = (id = 'a2', over = {}) => ({
  type: 'event', event: 'exec.approval.requested',
  payload: { id, request: { command: 'touch /tmp/x', cwd: CWD, host: 'gateway', nodeId: null, sessionKey: SK, allowedDecisions: ['allow-once', 'deny'], ...over } },
});

test('the failure text, gateway and node hosts', () => {
  assert.equal(LOST_ALLOW_RE.exec('Exec denied (gateway id=4aef-1, approval-request-failed): ls')[1], '4aef-1');
  assert.equal(LOST_ALLOW_RE.exec('Exec denied (node=mac id=b2, approval-request-failed): ls')[1], 'b2');
  assert.equal(LOST_ALLOW_RE.exec('Exec denied (gateway id=c3, user-denied): ls'), null);
  assert.equal(LOST_ALLOW_RE.exec('Exec denied (gateway id=c3, approval-timeout): ls'), null);
});

test('a lost user Allow: rerun note once the run replied, the rerun gets the same decision once', async () => {
  const { r, sent } = setup();
  r.onApprovalEvent(allowed());
  await settle();
  const [note] = sent('chat.send');
  assert.equal(note.params.sessionKey, SK);
  assert.equal(note.params.idempotencyKey, 'cc-lost-allow-a1');
  assert.match(note.params.message, /touch \/tmp\/x/);
  r.onApprovalEvent(rerun('a2'));
  assert.deepEqual(sent('exec.approval.resolve').map(c => c.params), [{ id: 'a2', decision: 'allow-once' }]);
  r.onApprovalEvent(rerun('a3'));
  assert.equal(sent('exec.approval.resolve').length, 1, 'used once: a second request still asks');
});

test('the note waits for the run to reply after the failure', async () => {
  const { r, sent } = setup({ transcript: n => n < 3 ? [user, failedResult()] : [user, failedResult(), reply], replyWaitMs: 5000, pollMs: 40 });
  r.onApprovalEvent(allowed());
  await settle();
  assert.equal(sent('chat.send').length, 0);
  await new Promise(res => setTimeout(res, 200));
  assert.equal(sent('chat.send').length, 1);
});

test('the agent retrying by itself before replying uses the Allow, and no note is sent', async () => {
  const { r, sent } = setup({ transcript: [user, failedResult()], replyWaitMs: 100, pollMs: 20 });
  r.onApprovalEvent(allowed());
  await settle();
  r.onApprovalEvent(rerun('a2'));
  await new Promise(res => setTimeout(res, 150));
  assert.equal(sent('exec.approval.resolve').length, 1);
  assert.equal(sent('chat.send').length, 0);
});

test('an Allow whose command ran is left alone', async () => {
  const { r, sent } = setup({ transcript: [user, { role: 'toolResult', content: [{ type: 'text', text: '' }] }, reply] });
  r.onApprovalEvent(allowed());
  await settle();
  r.onApprovalEvent(rerun('a2'));
  assert.equal(sent('chat.send').length + sent('exec.approval.resolve').length, 0);
});

test('Always allow is carried over when the rerun offers it, else allow-once', async () => {
  const a = setup({ items: [historyItem({ decision: 'allow-always' })] });
  a.r.onApprovalEvent(allowed('a1', 'allow-always'));
  await settle();
  a.r.onApprovalEvent(rerun('a2', { allowedDecisions: ['allow-once', 'allow-always', 'deny'] }));
  assert.equal(a.sent('exec.approval.resolve')[0].params.decision, 'allow-always');
  const b = setup({ items: [historyItem({ decision: 'allow-always' })] });
  b.r.onApprovalEvent(allowed('a1', 'allow-always'));
  await settle();
  b.r.onApprovalEvent(rerun('a2'));
  assert.equal(b.sent('exec.approval.resolve')[0].params.decision, 'allow-once');
});

test('nothing is approved that the user did not allow', async () => {
  for (const item of [
    historyItem({ status: 'denied', decision: 'deny' }),
    historyItem({ reason: 'timeout', decision: null, status: 'expired' }),
    historyItem({ id: 'other' }),
    historyItem({ presentation: { kind: 'plugin', commandText: 'touch /tmp/x' } }),
  ]) {
    const { r, sent } = setup({ items: [item] });
    r.onApprovalEvent(allowed());
    await settle();
    r.onApprovalEvent(rerun('a2'));
    assert.equal(sent('chat.send').length + sent('exec.approval.resolve').length, 0, JSON.stringify(item));
  }
  // A Deny or an expiry is never even looked at.
  const { r, calls } = setup();
  r.onApprovalEvent({ event: 'exec.approval.resolved', payload: { id: 'a1', decision: 'deny' } });
  r.onApprovalEvent({ event: 'exec.approval.resolved', payload: { id: 'a1', decision: null } });
  await settle();
  assert.equal(calls.length, 0);
});

test('a rerun that differs in command, session, host, node or cwd still asks', async () => {
  for (const over of [{ command: 'touch /tmp/y' }, { sessionKey: 'agent:main:other' }, { host: 'node' }, { nodeId: 'mac' }, { cwd: '/' }]) {
    const { r, sent } = setup();
    r.onApprovalEvent(allowed());
    await settle();
    r.onApprovalEvent(rerun('a2', over));
    assert.equal(sent('exec.approval.resolve').length, 0, JSON.stringify(over));
  }
});

test('each Allow is checked once', async () => {
  const { r, sent } = setup();
  r.onApprovalEvent(allowed());
  r.onApprovalEvent(allowed());
  await settle();
  assert.equal(sent('approval.history').length, 1);
  assert.equal(sent('chat.send').length, 1);
});

test('a kept Allow expires', async () => {
  let t = 1000;
  const { r, sent } = setup({ now: () => t, keepMs: 5000 });
  r.onApprovalEvent(allowed());
  await settle();
  t += 6000;
  r.onApprovalEvent(rerun('a2'));
  assert.equal(sent('exec.approval.resolve').length, 0);
});
