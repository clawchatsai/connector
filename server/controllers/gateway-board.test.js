import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseBoardTarget, resolveSandboxPort, createGatewayBoardHandler } from './gateway-board.js';

test('board documents pass with only their view ticket', () => {
  assert.deepEqual(parseBoardTarget('/__openclaw__/board/agent%3Amain%3Amain/status/index.html?bt=v1.t.s'),
    { kind: 'board', path: '/__openclaw__/board/agent%3Amain%3Amain/status/index.html?bt=v1.t.s' });
  for (const bad of [
    '/__openclaw__/board/a/b/',                       // no ticket
    '/__openclaw__/board/a/b/?bt=x&token=y',          // extra parameter
    '/__openclaw__/board/a/b/?bt=x#frag',
    '/__openclaw__/board/../config?bt=x',
    '/__openclaw__/board/a/%2e%2e/b?bt=x',
    '/__openclaw__/board/?bt=x',
    '//evil.example/__openclaw__/board/a?bt=x',
    'http://127.0.0.1:1/__openclaw__/board/a?bt=x',
    '/api/chat/media/outgoing/a?bt=x',
    '/__openclaw__/boardx/a?bt=x',
  ]) assert.equal(parseBoardTarget(bad), null, bad);
});

test('the sandbox shell passes with only its csp and version', () => {
  assert.deepEqual(parseBoardTarget('/mcp-app-sandbox?csp=eyJhIjoxfQ&v=abc123'), { kind: 'sandbox', path: '/mcp-app-sandbox?csp=eyJhIjoxfQ&v=abc123' });
  assert.deepEqual(parseBoardTarget('/mcp-app-sandbox?v=abc'), { kind: 'sandbox', path: '/mcp-app-sandbox?v=abc' });
  for (const bad of ['/mcp-app-sandbox?v=a&x=1', '/mcp-app-sandbox?v=a&v=b', '/mcp-app-sandbox/x', '/mcp-app-sandbox?csp=a%20b'])
    assert.equal(parseBoardTarget(bad), null, bad);
});

test('sandbox port: configured, else gateway + 1, never the gateway port', () => {
  assert.equal(resolveSandboxPort(18789), 18790);
  assert.equal(resolveSandboxPort(18789, 19000), 19000);
  assert.equal(resolveSandboxPort(18789, 18789), null);
  assert.equal(resolveSandboxPort(65535), null);
});

function fakeRes() {
  return new Promise(resolve => {
    const res = { status: 0, headers: {}, writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { resolve({ status: this.status, body: JSON.parse(b) }); } };
    resolve.res = res;
    fakeRes.last = res;
  });
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { return await fn(server.address().port); } finally { server.close(); }
}

test('reads the document from the gateway port without credentials and returns html + csp', async () => {
  await withServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.url, '/__openclaw__/board/s/w/?bt=T');
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'" });
    res.end('<p>hi</p>');
  }, async port => {
    const handle = createGatewayBoardHandler({ gatewayWsUrl: `ws://127.0.0.1:${port}` });
    const done = fakeRes();
    handle({}, fakeRes.last, { u: '/__openclaw__/board/s/w/?bt=T' });
    assert.deepEqual(await done, { status: 200, body: { html: '<p>hi</p>', csp: "default-src 'none'" } });
  });
});

test('passes the gateway status through (401 = expired ticket) and refuses other URLs', async () => {
  await withServer((req, res) => { res.writeHead(401); res.end('Unauthorized'); }, async port => {
    const handle = createGatewayBoardHandler({ gatewayWsUrl: `ws://127.0.0.1:${port}` });
    let done = fakeRes();
    handle({}, fakeRes.last, { u: '/__openclaw__/board/s/w/?bt=old' });
    assert.equal((await done).status, 401);
    done = fakeRes();
    handle({}, fakeRes.last, { u: '/api/config' });
    assert.equal((await done).status, 400);
  });
});

test('reads the sandbox shell from the sandbox port', async () => {
  await withServer((req, res) => { res.writeHead(200, { 'Content-Security-Policy': "frame-ancestors http: https:" }); res.end('<!doctype html>shell'); }, async port => {
    const handle = createGatewayBoardHandler({ gatewayWsUrl: 'ws://127.0.0.1:1', sandboxPort: port });
    const done = fakeRes();
    handle({}, fakeRes.last, { u: '/mcp-app-sandbox?v=1' });
    assert.deepEqual(await done, { status: 200, body: { html: '<!doctype html>shell', csp: 'frame-ancestors http: https:' } });
  });
});
