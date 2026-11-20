// P2P rpc-res bodies: text types go as UTF-8 strings, everything else as a base64 _binary envelope.
// Regression: a .kmz/.xlsx/.docx (types outside the old image|audio|video|octet-stream|pdf list) was
// decoded as UTF-8, so every byte >= 0x80 became U+FFFD and the download grew and broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchRpc, rpcResponseBody, isTextContentType } from '../dist/shim.js';

// Every byte value, so any lossy decode changes the result.
const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

async function serve(contentType, body) {
  const response = await dispatchRpc({ id: '1', method: 'GET', url: '/f' }, (req, res) => {
    res.writeHead(200, contentType ? { 'Content-Type': contentType } : {});
    res.end(body);
  });
  // The wire round trip: index.ts JSON.stringify's the rpc-res, the browser JSON.parse's it.
  return JSON.parse(JSON.stringify({ body: rpcResponseBody(response) })).body;
}

const decodeEnvelope = (b) => {
  assert.equal(b?._binary, true, `expected a _binary envelope, got ${JSON.stringify(b)?.slice(0, 80)}`);
  return Buffer.from(b.data, 'base64');
};

for (const ct of [
  'application/vnd.google-earth.kmz',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
  'application/gzip',
  'application/octet-stream',
  'application/pdf',
  'image/png',
  'image/svg+xml',
  'audio/mpeg',
  'video/mp4',
  'font/woff2',
]) {
  test(`${ct} arrives byte-exact in a _binary envelope`, async () => {
    const b = await serve(ct, ALL_BYTES);
    assert.equal(b.contentType, ct);
    assert.deepEqual(decodeEnvelope(b), ALL_BYTES);
  });
}

for (const ct of [
  'application/json',
  'application/json; charset=utf-8',
  'Application/JSON',
  'application/problem+json',
  'application/xml',
  'application/atom+xml',
  'application/javascript',
  'application/x-www-form-urlencoded',
  'application/yaml',
  'text/plain',
  'text/plain; charset=utf-8',
  'text/html',
  'text/csv',
  'text/markdown',
]) {
  test(`${ct} goes as a plain string`, async () => {
    const text = '{"ok":true,"name":"Zoë – ✓ 日本"}';
    assert.equal(await serve(ct, text), text);
  });
}

test('a JSON API response stays a string the transport can parse (no base64 per RPC)', async () => {
  const b = await serve('application/json', JSON.stringify({ threads: [1, 2] }));
  assert.equal(typeof b, 'string');
  assert.deepEqual(JSON.parse(b), { threads: [1, 2] });
});

test('no content type: sent as text, as before', async () => {
  assert.equal(await serve(null, 'plain body'), 'plain body');
});

test('no body: sent as an empty string, not an envelope', async () => {
  assert.equal(await serve('application/zip', undefined), '');
  assert.equal(await serve('image/png', Buffer.alloc(0)), '');
});

test('a text type whose bytes are not UTF-8 is wrapped, so a Latin-1 CSV downloads unchanged', async () => {
  const latin1 = Buffer.from('caf\xe9;na\xefve\n', 'latin1');
  const b = await serve('text/csv', latin1);
  assert.equal(b.contentType, 'text/csv');
  assert.deepEqual(decodeEnvelope(b), latin1);
});

test('isTextContentType: suffix rules apply to application/ only; unknown types are binary', () => {
  assert.equal(isTextContentType('application/ld+json'), true);
  assert.equal(isTextContentType('application/rss+xml; charset=utf-8'), true);
  assert.equal(isTextContentType('image/svg+xml'), false);
  assert.equal(isTextContentType('application/jsonx'), false);
  assert.equal(isTextContentType('application/vnd.ms-excel'), false);
  assert.equal(isTextContentType(''), false);
});
