import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { parseTunnelLabel, gatewaySocketUrl, openDesktopTunnel, CHUNK, HIGH_WATER } from './desktop-tunnel.js';

test('parseTunnelLabel allows only the desktop stream paths with a token', () => {
  assert.equal(parseTunnelLabel('tunnel:/desktop/observe?token=abc'), '/desktop/observe?token=abc');
  assert.equal(parseTunnelLabel('tunnel:/desktop/audio?token=a%2Fb'), '/desktop/audio?token=a%2Fb');
  for (const bad of [
    'clawchats', 'tunnel:', 'tunnel:/desktop/observe', 'tunnel:/desktop/observe?token=',
    'tunnel:/desktop/observe?token=a&x=1', 'tunnel:/ws?token=a', 'tunnel://evil.com/desktop/observe?token=a',
    'tunnel:http://127.0.0.1/desktop/observe?token=a', 'tunnel:/desktop/observe/../../x?token=a',
    'tunnel:/desktop/observe?token=a#x', `tunnel:/desktop/observe?token=${'a'.repeat(3000)}`, null,
  ]) assert.equal(parseTunnelLabel(bad), null, String(bad).slice(0, 60));
});

test('gatewaySocketUrl keeps the gateway host and replaces the path', () => {
  assert.equal(gatewaySocketUrl('ws://localhost:18789', '/desktop/observe?token=t'), 'ws://localhost:18789/desktop/observe?token=t');
  assert.equal(gatewaySocketUrl('ws://127.0.0.1:1/some/path', '/desktop/audio?token=t'), 'ws://127.0.0.1:1/desktop/audio?token=t');
});

/** A W3C-style DataChannel double: records sends, exposes bufferedAmount, and can be closed. */
function fakeChannel(label, { readyState = 'open' } = {}) {
  const dc = {
    label, readyState, binaryType: 'blob', bufferedAmount: 0, bufferedAmountLowThreshold: 0,
    sent: [], closed: false, onmessage: null, onclose: null, onopen: null, onbufferedamountlow: null,
    send(data) { if (this.readyState !== 'open') throw new Error('not open'); this.sent.push(data); },
    close() { if (this.closed) return; this.closed = true; this.readyState = 'closed'; this.onclose?.(); },
    fromBrowser(bytes) { this.onmessage?.({ data: new Uint8Array(bytes).buffer }); },
    binary() { return Buffer.concat(this.sent.filter(d => typeof d !== 'string').map(d => Buffer.from(d))); },
    control() { return this.sent.filter(d => typeof d === 'string').map(d => JSON.parse(d)); },
  };
  return dc;
}

async function gateway(onConnection, { verifyClient } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', ...(verifyClient ? { verifyClient } : {}) });
  await new Promise(r => wss.on('listening', r));
  wss.on('connection', onConnection);
  return { wss, url: `ws://127.0.0.1:${wss.address().port}`, close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
};

test('pipes bytes both ways, in chunks toward the browser', async () => {
  let gwSocket, gwPath, received = [];
  const gw = await gateway((ws, req) => {
    gwSocket = ws; gwPath = req.url;
    ws.on('message', d => received.push(Buffer.from(d)));
    ws.send(Buffer.alloc(CHUNK * 2 + 5, 7)); // the gateway speaks first (RFB version)
  });
  const dc = fakeChannel('tunnel:/desktop/observe?token=tok');
  openDesktopTunnel(dc, { gatewayUrl: gw.url, log: { warn() {} } });
  dc.fromBrowser([1, 2, 3]); // queued until the gateway socket opens
  await until(() => dc.binary().length === CHUNK * 2 + 5);
  assert.equal(gwPath, '/desktop/observe?token=tok');
  assert.deepEqual(dc.sent.map(d => d.byteLength ?? d.length), [CHUNK, CHUNK, 5]);
  await until(() => received.length === 1);
  assert.deepEqual([...received[0]], [1, 2, 3]);
  dc.fromBrowser([4]);
  await until(() => received.length === 2);
  gwSocket.close(4000, 'control-taken:Ada');
  await until(() => dc.closed);
  assert.deepEqual(dc.control(), [{ type: 'close', code: 4000, reason: 'control-taken:Ada' }]);
  await gw.close();
});

test('closing the channel closes the gateway socket', async () => {
  let closedCode = null;
  const gw = await gateway(ws => ws.on('close', code => { closedCode = code; }));
  const dc = fakeChannel('tunnel:/desktop/observe?token=t');
  openDesktopTunnel(dc, { gatewayUrl: gw.url });
  await until(() => gw.wss.clients.size === 1);
  dc.close();
  await until(() => closedCode !== null);
  assert.equal(closedCode, 1000);
  await gw.close();
});

test('a refused upgrade reaches the browser as a close reason', async () => {
  const gw = await gateway(() => {}, { verifyClient: (_info, done) => done(false, 401) });
  const dc = fakeChannel('tunnel:/desktop/observe?token=used');
  openDesktopTunnel(dc, { gatewayUrl: gw.url, log: { warn() {} } });
  await until(() => dc.closed);
  assert.deepEqual(dc.control(), [{ type: 'close', code: 1006, reason: 'the gateway refused the desktop stream (HTTP 401)' }]);
  await gw.close();
});

test('a disallowed label closes the channel without connecting', async () => {
  let connections = 0;
  const gw = await gateway(() => { connections++; });
  const dc = fakeChannel('tunnel:/ws?token=x');
  assert.equal(openDesktopTunnel(dc, { gatewayUrl: gw.url }), null);
  assert.equal(dc.closed, true);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(connections, 0);
  await gw.close();
});

test('stops reading the gateway while the channel is backed up, resumes when it drains', async () => {
  let gwSocket;
  const gw = await gateway(ws => { gwSocket = ws; });
  const dc = fakeChannel('tunnel:/desktop/observe?token=t');
  openDesktopTunnel(dc, { gatewayUrl: gw.url });
  await until(() => gwSocket);
  dc.bufferedAmount = HIGH_WATER + 1; // the link is slow: lots still queued
  gwSocket.send(Buffer.alloc(10, 1));
  await until(() => dc.sent.length === 1);
  gwSocket.send(Buffer.alloc(10, 2)); // arrives at the connector but isn't read while paused
  await new Promise(r => setTimeout(r, 150));
  assert.equal(dc.sent.length, 1);
  dc.bufferedAmount = 0;
  dc.onbufferedamountlow();
  await until(() => dc.sent.length === 2);
  dc.close();
  await gw.close();
});

test('a channel that is still connecting waits for open before dialling the gateway', async () => {
  let connections = 0;
  const gw = await gateway(ws => { connections++; ws.send(Buffer.from([9])); });
  const dc = fakeChannel('tunnel:/desktop/observe?token=t', { readyState: 'connecting' });
  openDesktopTunnel(dc, { gatewayUrl: gw.url });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(connections, 0);
  dc.readyState = 'open';
  dc.onopen();
  await until(() => dc.binary().length === 1);
  dc.close();
  await gw.close();
});
