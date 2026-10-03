import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { GatewayClient } from './gateway.js';
import { APPROVAL_EVENT_RE } from './approval-client.js';

const logger = { logFrame() {} };
const wait = ms => new Promise(r => setTimeout(r, ms));

/** A fake gateway: challenges each connection, records connect params, can push events. */
async function fakeGateway() {
  const wss = new WebSocketServer({ port: 0 });
  const conns = [];
  wss.on('connection', ws => {
    const c = { ws, params: null, closed: false };
    conns.push(c);
    ws.on('close', () => { c.closed = true; });
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'connect') { c.params = msg.params; ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: { type: 'hello-ok' } })); }
    });
    ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' } }));
  });
  await new Promise(r => wss.once('listening', r));
  return { wss, conns, url: `ws://127.0.0.1:${wss.address().port}`, approvalConns: () => conns.filter(c => c.params?.caps?.includes('approvals')) };
}

function client(url, graceMs = 50) {
  const dataDir = '/tmp/cc-approval-client-test';
  return new GatewayClient({ dataDir, debugLogger: logger, gatewayWsUrl: url, authToken: '', approvalClientGraceMs: graceMs });
}

test('approval events only: requested/resolved for exec, plugin and system-agent', () => {
  for (const e of ['exec.approval.requested', 'plugin.approval.resolved', 'openclaw.approval.requested']) assert.ok(APPROVAL_EVENT_RE.test(e), e);
  for (const e of ['session.approval', 'exec.approval.list', 'chat', 'sessions.changed']) assert.ok(!APPROVAL_EVENT_RE.test(e), e);
});

test('no browser: no approval-client connection; main connection never declares approvals', async () => {
  const gw = await fakeGateway();
  const c = client(gw.url);
  c.connect();
  await wait(200);
  assert.equal(gw.conns.length, 1);
  assert.deepEqual(gw.conns[0].params.caps, ['tool-events']);
  assert.equal(gw.approvalConns().length, 0);
  c.close();
  await new Promise(r => gw.wss.close(r));
});

test('a browser attaches: approval-client connection with the approvals cap; its approval events reach browsers, others are dropped', async () => {
  const gw = await fakeGateway();
  const c = client(gw.url);
  const received = [];
  c.addBroadcastTarget(d => received.push(JSON.parse(d)));
  let n = 0;
  c.setExternalBrowserCount(() => n);
  n = 1; c.browsersChanged();
  await wait(200);
  const [ac] = gw.approvalConns();
  assert.ok(ac, 'approval-client connection opened');
  assert.deepEqual(ac.params.scopes.includes('operator.approvals'), true);
  ac.ws.send(JSON.stringify({ type: 'event', event: 'plugin.approval.requested', payload: { id: 'plugin:1' } }));
  ac.ws.send(JSON.stringify({ type: 'event', event: 'sessions.changed', payload: {} }));
  ac.ws.send(JSON.stringify({ type: 'event', event: 'plugin.approval.resolved', payload: { id: 'plugin:1' } }));
  await wait(100);
  assert.deepEqual(received.map(m => m.event), ['plugin.approval.requested', 'plugin.approval.resolved']);
  c.close();
  await new Promise(r => gw.wss.close(r));
});

test('last browser leaves: closed after the grace period; a browser back within it keeps the same connection', async () => {
  const gw = await fakeGateway();
  const c = client(gw.url, 150);
  let n = 1;
  c.setExternalBrowserCount(() => n);
  await wait(200);
  assert.equal(gw.approvalConns().length, 1);
  n = 0; c.browsersChanged();
  await wait(50);
  n = 1; c.browsersChanged(); // reconnect within grace
  await wait(250);
  assert.equal(gw.approvalConns().length, 1);
  assert.equal(gw.approvalConns()[0].closed, false);
  n = 0; c.browsersChanged();
  await wait(300);
  assert.equal(gw.approvalConns()[0].closed, true);
  assert.equal(c.approvalClient.running, false);
  c.close();
  await new Promise(r => gw.wss.close(r));
});

test('local WebSocket browsers count too; close() stops the approval-client connection', async () => {
  const gw = await fakeGateway();
  const c = client(gw.url);
  const fakeWs = { readyState: 3, send() {} };
  c.addBrowserClient(fakeWs);
  await wait(200);
  assert.equal(gw.approvalConns().length, 1);
  c.close();
  await wait(100);
  assert.equal(gw.approvalConns()[0].closed, true);
  c.browsersChanged(); // ignored after close
  await wait(100);
  assert.equal(gw.approvalConns().length, 1);
  await new Promise(r => gw.wss.close(r));
});
