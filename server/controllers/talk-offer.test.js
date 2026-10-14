import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { isAllowedOfferPath, createTalkOfferHandler } from './talk-offer.js';

test('only realtime broker routes are reachable', () => {
  assert.equal(isAllowedOfferPath('/plugins/openai/realtime/calls'), true);
  assert.equal(isAllowedOfferPath('/plugins/google/realtime/calls'), true);
  for (const p of ['/api/sessions', '/plugins/openai/realtime/calls/x', '/plugins/../realtime/calls', '/plugins/a/b/realtime/calls', 'http://evil/plugins/openai/realtime/calls', '', null]) {
    assert.equal(isAllowedOfferPath(p), false, String(p));
  }
});

function fakeRes() {
  const r = { status: 0, body: '', headersSent: false, writeHead(s) { r.status = s; r.headersSent = true; }, end(b) { r.body = b; r.done?.(); } };
  return r;
}
const fakeReq = body => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} });

test('relays the SDP offer with the call token as Bearer, never the gateway token', async () => {
  let seen;
  const gw = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { seen = { url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], x: req.headers['x-extra'], cookie: req.headers.cookie, body: Buffer.concat(chunks).toString() }; res.writeHead(201); res.end('v=0 answer'); });
  });
  await new Promise(r => gw.listen(0, '127.0.0.1', r));
  try {
    const handler = createTalkOfferHandler({ gatewayWsUrl: `ws://127.0.0.1:${gw.address().port}` });
    const res = fakeRes();
    const done = new Promise(r => { res.done = r; });
    await handler(fakeReq({ path: '/plugins/openai/realtime/calls', sdp: 'v=0 offer', clientSecret: 'tok123', headers: { 'X-Extra': '1', Cookie: 'no' } }), res);
    await done;
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { status: 201, body: 'v=0 answer' });
    assert.deepEqual(seen, { url: '/plugins/openai/realtime/calls', auth: 'Bearer tok123', type: 'application/sdp', x: '1', cookie: undefined, body: 'v=0 offer' });
  } finally { gw.close(); }
});

test('rejects other routes and missing fields without calling the gateway', async () => {
  const handler = createTalkOfferHandler({ gatewayWsUrl: 'ws://127.0.0.1:1' });
  for (const body of [{ path: '/api/sessions', sdp: 'x', clientSecret: 't' }, { path: '/plugins/openai/realtime/calls', clientSecret: 't' }, { path: '/plugins/openai/realtime/calls', sdp: 'x' }]) {
    const res = fakeRes();
    await handler(fakeReq(body), res);
    assert.equal(res.status, 400);
  }
});
