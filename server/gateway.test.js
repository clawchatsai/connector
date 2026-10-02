import { test } from 'node:test';
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
