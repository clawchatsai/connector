import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createShareHandlers, validEnvelope, cleanSource } from './shares.js';
import { buildSharePage } from '../share/viewer-page.js';
import { decryptShare, needsPassword } from '../share/viewer-decrypt.js';

const CFG = { provider: 'r2', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'clawchats-shares', accessKeyId: 'id', secretAccessKey: 'sk', publicBaseUrl: 'https://pub-x.r2.dev' };
const ENV = { v: 1, alg: 'A256GCM', iv: 'aaa', ct: 'bbb' };

function call(fn, body, ...args) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return new Promise((resolve, reject) => {
    const res = { writeHead(status) { this.status = status; }, end(data) { resolve({ status: this.status, body: JSON.parse(data) }); } };
    Promise.resolve(fn(req, res, ...args)).catch(reject);
  });
}

function setup({ configured = true, putStatus = 200, deleteStatus = 204, setupImpl } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-'));
  if (configured) fs.writeFileSync(path.join(dataDir, 'share-storage.json'), JSON.stringify(CFG));
  const ops = [];
  const s3Factory = cfg => ({
    put: async (key, body, opts) => { ops.push({ op: 'put', key, body, opts, cfg }); return { status: putStatus }; },
    delete: async key => { ops.push({ op: 'delete', key }); return { status: deleteStatus }; },
  });
  const h = createShareHandlers({ dataDir, s3Factory, setup: setupImpl || (async () => CFG), sweepTimer: false });
  return { dataDir, ops, h };
}

// Same envelope format as the browser (clawchats frontend/share/share-crypto.js).
async function encrypt(payload, password) {
  const b64u = b => Buffer.from(b).toString('base64url');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let key, secret = null, kdf;
  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    kdf = { name: 'PBKDF2', hash: 'SHA-256', iter: 600000, salt: b64u(salt) };
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  } else {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    secret = b64u(raw);
    key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  }
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { envelope: { v: 1, alg: 'A256GCM', iv: b64u(iv), ct: b64u(ct), ...(kdf ? { kdf } : {}) }, secret };
}

test('create uploads one self-contained HTML page to the user bucket and records the share without keys', async () => {
  const { dataDir, ops, h } = setup();
  const r = await call(h.handleCreate, { envelope: ENV, title: 'Login flow', type: 'mermaid' });
  assert.equal(r.status, 201);
  const { share } = r.body;
  assert.match(share.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(share.url, `https://pub-x.r2.dev/shares/${share.id}.html`);
  assert.equal(ops[0].key, `shares/${share.id}.html`);
  assert.equal(ops[0].opts.contentType, 'text/html; charset=utf-8');
  assert.ok(ops[0].body.includes('"ct":"bbb"'), 'ciphertext embedded');
  assert.ok(!/\{\{(ENVELOPE_JSON|DECRYPT_JS)\}\}/.test(ops[0].body), 'no unfilled placeholders');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'shares.json'), 'utf8'));
  assert.equal(saved[0].id, share.id);
  assert.equal(fs.statSync(path.join(dataDir, 'shares.json')).mode & 0o777, 0o600);
  const list = await call(h.handleList);
  assert.equal(list.body.configured, true);
  assert.deepEqual(list.body.storage, { provider: 'r2', bucket: 'clawchats-shares', publicBaseUrl: 'https://pub-x.r2.dev' });
  assert.ok(!JSON.stringify(list.body).includes('sk'), 'credentials never leave the connector');
});

test('without storage the list says so and create asks to connect', async () => {
  const { h } = setup({ configured: false });
  assert.equal((await call(h.handleList)).body.configured, false);
  assert.equal((await call(h.handleCreate, { envelope: ENV, type: 'html' })).status, 409);
});

test('setup saves derived credentials (0600) after a successful test upload, and can be forgotten', async () => {
  const { dataDir, ops, h } = setup({ configured: false });
  const r = await call(h.handleSetup, { token: 't'.repeat(40) });
  assert.equal(r.status, 200);
  assert.equal(r.body.storage.publicBaseUrl, 'https://pub-x.r2.dev');
  assert.deepEqual(ops.map(o => o.op), ['put', 'delete'], 'probe uploaded and removed');
  const file = path.join(dataDir, 'share-storage.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await call(h.handleForgetStorage)).status, 200);
  assert.equal(fs.existsSync(file), false);
});

test('setup errors are reported and nothing is saved', async () => {
  const bad = setup({ configured: false, setupImpl: async () => { throw Object.assign(new Error('Cloudflare rejected this token.'), { code: 'rejected' }); } });
  assert.deepEqual(await call(bad.h.handleSetup, { token: 'x' }), { status: 400, body: { error: 'Cloudflare rejected this token.' } });
  const refused = setup({ configured: false, putStatus: 403 });
  assert.equal((await call(refused.h.handleSetup, { token: 't'.repeat(40) })).status, 502);
  assert.equal(fs.existsSync(path.join(refused.dataDir, 'share-storage.json')), false);
});

test('rejects plaintext-looking or malformed envelopes, unknown types and past expiry before uploading', async () => {
  const { ops, h } = setup();
  assert.equal((await call(h.handleCreate, { envelope: { ...ENV, content: 'plain' }, type: 'html' })).status, 400);
  assert.equal((await call(h.handleCreate, { envelope: { ...ENV, ct: 'no spaces!' }, type: 'html' })).status, 400);
  assert.equal((await call(h.handleCreate, { envelope: ENV, type: 'exe' })).status, 400);
  assert.equal((await call(h.handleCreate, { envelope: ENV, type: 'html', expiresAt: '2020-01-01' })).status, 400);
  assert.equal(ops.length, 0);
  assert.equal(validEnvelope({ ...ENV, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 1000, salt: 'aa' } }), false, 'weak KDF refused');
});

test('revoke deletes the page from the bucket and drops the row; a 404 still clears it', async () => {
  const { dataDir, ops, h } = setup({ deleteStatus: 404 });
  const { body } = await call(h.handleCreate, { envelope: ENV, type: 'html' });
  assert.equal((await call(h.handleRevoke, undefined, body.share.id)).status, 200);
  assert.deepEqual(ops[1], { op: 'delete', key: `shares/${body.share.id}.html` });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'shares.json'), 'utf8')), []);
  assert.equal((await call(h.handleRevoke, undefined, '../etc')).status, 400);
});

test('sweep deletes expired shares from the bucket and the list', async () => {
  const { dataDir, ops, h } = setup();
  const old = 'a'.repeat(22), keep = 'b'.repeat(22);
  fs.writeFileSync(path.join(dataDir, 'shares.json'), JSON.stringify([
    { id: old, createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z' },
    { id: keep, createdAt: '2026-01-01T00:00:00Z', expiresAt: null },
  ]));
  const list = await call(h.handleList);
  assert.deepEqual(list.body.shares.map(s => s.id), [keep]);
  assert.deepEqual(ops, [{ op: 'delete', key: `shares/${old}.html` }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'shares.json'), 'utf8')).map(s => s.id), [keep]);
});

test('share page embeds the envelope safely, and its decrypt code opens link and password shares', async () => {
  const payload = { v: 1, kind: 'artifact', title: 'T', type: 'html', content: '</script><script>alert(1)</script>' };
  const link = await encrypt(payload);
  const page = buildSharePage({ ...link.envelope });
  const m = page.match(/<script type="application\/json" id="share-envelope">([^<]*)<\/script>/);
  assert.ok(m, 'envelope sits in its own JSON script element');
  assert.deepEqual(JSON.parse(m[1]), link.envelope);
  assert.ok(page.includes('async function decryptShare'), 'decrypt code inlined');
  assert.ok(!/^export /m.test(page), 'no ES module syntax left in the inline script');
  assert.deepEqual(await decryptShare(link.envelope, { secret: link.secret }), payload);
  const pw = await encrypt(payload, 'correct horse battery');
  assert.equal(needsPassword(pw.envelope), true);
  assert.deepEqual(await decryptShare(pw.envelope, { password: 'correct horse battery' }), payload);
  await assert.rejects(decryptShare(pw.envelope, { password: 'nope' }), { code: 'bad-password' });
});

test('whole-chat shares are accepted and uploaded like artifacts', async () => {
  const { ops, h } = setup();
  const r = await call(h.handleCreate, { envelope: ENV, title: 'A chat', type: 'chat' });
  assert.equal(r.status, 201);
  assert.equal(r.body.share.type, 'chat');
  assert.ok(ops[0].body.includes('function chatPage'), 'the share page can render chats');
});

test('create records where the share came from, keeping only known fields', async () => {
  const { h } = setup();
  const r = await call(h.handleCreate, { envelope: ENV, title: 'A chat', type: 'chat', source: { kind: 'chat', chatId: 'agent:main:x', extra: 'dropped' } });
  assert.deepEqual(r.body.share.source, { kind: 'chat', chatId: 'agent:main:x' });
  assert.deepEqual((await call(h.handleList)).body.shares[0].source, { kind: 'chat', chatId: 'agent:main:x' });
  const plain = await call(h.handleCreate, { envelope: ENV, type: 'html', source: { kind: 'nope' } });
  assert.equal('source' in plain.body.share, false);
  assert.equal(cleanSource({ kind: 'file', path: 'a'.repeat(900), name: 5 }).path.length, 500);
  assert.equal(cleanSource({ kind: 'file', name: 5 }).name, undefined);
});
