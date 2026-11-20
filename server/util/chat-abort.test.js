import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatAbort, parseGatewayVersion } from './chat-abort.js';

const hello = version => ({ type: 'hello-ok', server: { version, connId: 'c' } });
/** A gateway whose chat.abort takes sessionId or (9.7) refuses it as an unknown property. */
function gateway({ fence }) {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'sessions.describe') return { session: { key: params.key, sessionId: 'phys-1' } };
    if (method === 'chat.abort' && 'sessionId' in params && !fence) {
      throw Object.assign(new Error("invalid chat.abort params: at root: unexpected property 'sessionId'"), { gatewayCode: 'INVALID_REQUEST' });
    }
    return { ok: true };
  };
  return { calls, request, aborts: () => calls.filter(c => c.method === 'chat.abort').map(c => c.params) };
}

test('versions: release, beta, v-prefix; nothing else', () => {
  assert.deepEqual(parseGatewayVersion('2026.11.6'), [2026, 11, 6]);
  assert.deepEqual(parseGatewayVersion('2026.11.5-beta.3'), [2026, 11, 5]);
  assert.deepEqual(parseGatewayVersion('v2026.9.7'), [2026, 9, 7]);
  assert.equal(parseGatewayVersion('dev'), null);
  assert.equal(parseGatewayVersion(undefined), null);
});

test('2026.11.5+: Stop carries the session fence', async () => {
  const g = gateway({ fence: true });
  const a = createChatAbort(g.request, { hello: () => hello('2026.11.6') });
  const sessionId = await a.sessionIdOf('k');
  assert.equal(sessionId, 'phys-1');
  await a.abort({ sessionKey: 'k', runId: 'r1', sessionId });
  assert.deepEqual(g.aborts(), [{ sessionKey: 'k', runId: 'r1', sessionId: 'phys-1' }]);
});

test('2026.9.7 (known from hello-ok): no fence, and no describe call for it', async () => {
  const g = gateway({ fence: false });
  const a = createChatAbort(g.request, { hello: () => hello('2026.9.7') });
  assert.equal(await a.sessionIdOf('k'), null);
  await a.abort({ sessionKey: 'k', runId: 'r1', sessionId: 'phys-1' });
  assert.deepEqual(g.calls, [{ method: 'chat.abort', params: { sessionKey: 'k', runId: 'r1' } }]);
});

test('version unknown: tried once; a gateway that refuses the field is asked again without it, and not again on that connection', async () => {
  const g = gateway({ fence: false });
  let h = { type: 'hello-ok' };
  const a = createChatAbort(g.request, { hello: () => h });
  await a.abort({ sessionKey: 'k', runId: 'r1', sessionId: 's' });
  await a.abort({ sessionKey: 'k', runId: 'r2', sessionId: 's' });
  assert.deepEqual(g.aborts(), [{ sessionKey: 'k', runId: 'r1', sessionId: 's' }, { sessionKey: 'k', runId: 'r1' }, { sessionKey: 'k', runId: 'r2' }]);
  h = { type: 'hello-ok' }; // reconnected (maybe to an upgraded gateway): asked again
  await a.abort({ sessionKey: 'k', runId: 'r3', sessionId: 's' });
  assert.equal('sessionId' in g.aborts()[3], true);
});

test('any other refusal is not retried without the fence', async () => {
  const request = async () => { throw Object.assign(new Error('sessionId requires an exact runId'), { gatewayCode: 'INVALID_REQUEST' }); };
  const a = createChatAbort(request, { hello: () => hello('2026.11.6') });
  await assert.rejects(a.abort({ sessionKey: 'k', runId: 'r', sessionId: 's' }), /exact runId/);
});
