import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { GatewayClient } from './gateway.js';

const logger = { logFrame() {} };

test('close() shuts the socket and stops reconnecting (plugin reload drain)', async () => {
  const wss = new WebSocketServer({ port: 0 });
  let connections = 0;
  wss.on('connection', () => { connections++; });
  await new Promise(r => wss.once('listening', r));
  const gw = new GatewayClient({ dataDir: '/tmp', debugLogger: logger, gatewayWsUrl: `ws://127.0.0.1:${wss.address().port}`, authToken: '' });
  gw.connect();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(connections, 1);

  const pending = gw.request('x').catch(e => e.message); // not connected (no handshake) → rejects
  gw.close();
  assert.equal(gw.ws, null);
  assert.match(await pending, /not connected|stopping/);

  gw.connect(); // ignored after close
  await new Promise(r => setTimeout(r, 1300)); // longer than the first reconnect delay
  assert.equal(connections, 1);
  await new Promise(r => wss.close(r));
});

test('request() keeps the error fields the gateway sends (gatewayCode, retryable, retryAfterMs, details)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-err-'));
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' } }));
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.method === 'connect') return ws.send(JSON.stringify({ type: 'res', id: m.id, ok: true, payload: { type: 'hello-ok' } }));
      if (m.method === 'chat.send') return ws.send(JSON.stringify({ type: 'res', id: m.id, ok: false, error: { code: 'UNAVAILABLE', message: 'chat.send unavailable during gateway startup', retryable: true, retryAfterMs: 500, details: { reason: 'startup-sidecars', method: 'chat.send' } } }));
      if (m.method === 'config.patch') return ws.send(JSON.stringify({ type: 'res', id: m.id, ok: false, error: { code: 'UNAVAILABLE', message: 'config.patch persisted but was not applied', details: { persistedConfig: { hash: 'h2' } } } }));
      if (m.method === 'sessions.subscribe') return ws.send(JSON.stringify({ type: 'res', id: m.id, ok: true, payload: {} }));
      ws.send(JSON.stringify({ type: 'res', id: m.id, ok: false, error: { message: 'plain failure' } })); // 9.7 style: code optional
    });
  });
  await new Promise(r => wss.once('listening', r));
  const gw = new GatewayClient({ dataDir: dir, debugLogger: logger, gatewayWsUrl: `ws://127.0.0.1:${wss.address().port}`, authToken: '' });
  gw.connect();
  for (let i = 0; i < 50 && !gw.connected; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(gw.connected);

  const startup = await gw.request('chat.send', {}).catch(e => e);
  assert.equal(startup.message, 'chat.send unavailable during gateway startup');
  assert.equal(startup.gatewayCode, 'UNAVAILABLE');
  assert.equal(startup.retryable, true);
  assert.equal(startup.retryAfterMs, 500);
  assert.equal(startup.details.reason, 'startup-sidecars');
  assert.equal(startup.code, undefined); // `code` stays the peer protocol's

  const persisted = await gw.request('config.patch', {}).catch(e => e);
  assert.equal(persisted.details.persistedConfig.hash, 'h2');
  assert.equal(persisted.retryable, undefined);

  const plain = await gw.request('x', {}).catch(e => e);
  assert.equal(plain.message, 'plain failure');
  assert.equal(plain.gatewayCode, undefined);

  gw.close();
  await new Promise(r => wss.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});
