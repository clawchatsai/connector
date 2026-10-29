// Login gate for browser DataChannels (src/auth-handler.ts), driven with fake channels and a
// real config.json on disk. Runs against the build (npm test runs tsc first).
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachBrowserChannel, revokeStaleChannels, loadAuthState, _resetAuthForTests,
  MAX_PENDING_CHANNELS, AUTH_TIMEOUT_MS,
} from '../dist/auth-handler.js';
import { readAuthConfig, removeBackupCode, updateConfig, writeConfig } from '../dist/config-store.js';
import { generateTotpSecret, generateTotp, generateBackupCodes, verifyBackupCode } from '../dist/totp.js';
import { generateSessionSecret, issueSessionToken } from '../dist/session-token.js';

let dir, CONFIG, STATE, n = 0;
const unhandled = [];
const onUnhandled = (e) => unhandled.push(e);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-auth-'));
  CONFIG = path.join(dir, 'config.json');
  STATE = path.join(dir, 'auth-state.json');
  _resetAuthForTests();
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  mock.restoreAll();
  mock.timers.reset();
  _resetAuthForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeConfig(over = {}) {
  const { codes, hashes } = generateBackupCodes();
  const cfg = {
    userId: 'user-1', serverUrl: 'wss://login.example/ws', apiKey: 'k', gatewayId: 'gw-1',
    schemaVersion: 2, installedAt: '2026-01-01T00:00:00Z',
    google: { clientId: 'cid', authorizedSub: 'sub-1', authorizedEmail: 'a@example.com' },
    totp: { secret: generateTotpSecret(), algorithm: 'SHA1', digits: 6, period: 30, enabledAt: '2026-01-01T00:00:00Z' },
    sessionSecret: generateSessionSecret(),
    backupCodeHashes: hashes,
    ...over,
  };
  return { cfg, codes };
}

/** What `openclaw clawchats reauth` writes: new TOTP + session secret + backup codes, nothing else. */
function reauth() {
  const { codes, hashes } = generateBackupCodes();
  const totpSecret = generateTotpSecret();
  updateConfig(CONFIG, (c) => {
    c.totp = { ...c.totp, secret: totpSecret };
    c.sessionSecret = generateSessionSecret();
    c.backupCodeHashes = hashes;
  });
  return { totpSecret, codes };
}

function hooks() {
  const h = {
    handled: [], authenticated: 0, failures: [], errors: [],
    loadAuthConfig: () => readAuthConfig(CONFIG),
    consumeBackupCode: (hash) => removeBackupCode(CONFIG, hash),
    onAuthenticated: () => { h.authenticated++; },
    onMessage: (m) => { h.handled.push(m); },
    onLoginFailure: (r) => { h.failures.push(r); },
    log: { info() {}, warn() {}, error: (m) => h.errors.push(m) },
  };
  return h;
}

function fakeDc() {
  const dc = {
    sent: [], closed: false, msgHandlers: [], closeHandlers: [],
    send(d) { dc.sent.push(JSON.parse(d)); },
    close() { if (dc.closed) return; dc.closed = true; for (const h of dc.closeHandlers) h(); },
    onMessage(h) { dc.msgHandlers.push(h); },
    onClosed(h) { dc.closeHandlers.push(h); },
    deliver(data) { for (const h of dc.msgHandlers) h(typeof data === 'string' ? data : JSON.stringify(data)); },
    last() { return dc.sent.at(-1); },
  };
  return dc;
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

function open(h) {
  const dc = fakeDc();
  dc.id = `conn_${++n}`;
  attachBrowserChannel(dc, dc.id, h);
  return dc;
}

async function loginFull(dc, code, extra = {}) {
  dc.deliver({ type: 'auth-full', idToken: 'signaling-verified', totp: code, nonce: dc.sent[0].nonce, sessionDays: 7, ...extra });
  await flush();
  return dc.last();
}

// ── 1. Fail closed ──────────────────────────────────────────────────────────

test('no valid config: every channel is refused and closed before any handler runs', async () => {
  const { cfg } = makeConfig();
  const cases = {
    missing: null,
    empty: '',
    'half-written': JSON.stringify(cfg, null, 2).slice(0, 200),
    'not an object': '[1,2]',
    'v2 without sessionSecret': JSON.stringify({ ...cfg, sessionSecret: undefined }),
    'v2 with a non-hex sessionSecret': JSON.stringify({ ...cfg, sessionSecret: 'short' }),
    'v2 with a non-string TOTP secret': JSON.stringify({ ...cfg, totp: { ...cfg.totp, secret: 42 } }),
    'v2 with bad backup codes': JSON.stringify({ ...cfg, backupCodeHashes: 'abc' }),
    'v1 (2FA never set up)': JSON.stringify({ ...cfg, schemaVersion: 1, totp: undefined, sessionSecret: undefined, backupCodeHashes: undefined }),
    'old install without schemaVersion (was the no-auth legacy path)': JSON.stringify({ ...cfg, schemaVersion: undefined, totp: undefined, sessionSecret: undefined }),
  };
  for (const [name, content] of Object.entries(cases)) {
    fs.rmSync(CONFIG, { force: true });
    if (content !== null) fs.writeFileSync(CONFIG, content);
    const h = hooks();
    const dc = open(h);
    assert.equal(dc.sent[0]?.type, 'auth-required-setup', name);
    assert.match(dc.sent[0].message, /openclaw clawchats (reauth|setup)/, name);
    assert.ok(dc.closed, `${name}: closed`);
    assert.equal(dc.msgHandlers.length, 0, `${name}: no message handler attached`);
    dc.deliver({ type: 'rpc', id: '1', method: 'GET', url: '/api/workspace' });
    await flush();
    assert.equal(h.handled.length, 0, name);
    assert.equal(h.authenticated, 0, name);
  }
});

test('config deleted (reset) while a login is pending: refused, not let in', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const h = hooks();
  const dc = open(h);
  assert.equal(dc.sent[0].type, 'auth-required');
  fs.rmSync(CONFIG);
  const reply = await loginFull(dc, generateTotp(cfg.totp.secret));
  assert.equal(reply.type, 'auth-required-setup');
  assert.ok(dc.closed);
  assert.equal(h.authenticated, 0);
});

test('nothing but auth messages is handled before login; queued messages follow the login in order', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const h = hooks();
  const dc = open(h);
  dc.deliver({ type: 'rpc', id: 'early', method: 'GET', url: '/api/settings' });
  dc.deliver({ type: 'gateway-msg', payload: '{}' });
  dc.deliver({ type: 'ping' });
  await flush();
  assert.equal(h.handled.length, 0);
  assert.ok(!dc.closed);
  dc.deliver({ type: 'auth-full', idToken: 'signaling-verified', totp: generateTotp(cfg.totp.secret), nonce: dc.sent[0].nonce });
  dc.deliver({ type: 'rpc', id: 'after-1' });
  dc.deliver({ type: 'rpc', id: 'after-2' });
  await flush();
  assert.equal(dc.sent.find(m => m.type === 'auth-ok')?.type, 'auth-ok');
  assert.deepEqual(h.handled.map(m => m.id), ['after-1', 'after-2']);
});

// ── 2. Malformed pre-auth messages never throw ──────────────────────────────

test('non-string totp / bad fields / bad JSON: channel closed, nothing thrown or left unhandled', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const bad = [
    (nonce) => ({ type: 'auth-full', idToken: 'signaling-verified', nonce }), // totp missing (was a gateway crash)
    (nonce) => ({ type: 'auth-full', idToken: 'signaling-verified', totp: 123456, nonce }),
    (nonce) => ({ type: 'auth-full', idToken: 'signaling-verified', totp: null, nonce }),
    (nonce) => ({ type: 'auth-full', idToken: 'signaling-verified', totp: { a: 1 }, nonce }),
    (nonce) => ({ type: 'auth-full', idToken: 'signaling-verified', totp: ['123456'], nonce }),
    (nonce) => ({ type: 'auth-full', idToken: 'signaling-verified', totp: 'A'.repeat(65), nonce }),
    (nonce) => ({ type: 'auth-full', idToken: 42, totp: '123456', nonce }),
    () => ({ type: 'auth-full', idToken: 'signaling-verified', totp: '123456', nonce: { $ne: 1 } }),
    () => ({ type: 'auth-session', sessionToken: 12 }),
    () => ({ type: 'auth-session', sessionToken: { length: 3 } }),
    () => ({ type: 'auth-session' }),
    () => '{"type":"auth-full",',
    () => 'null',
    () => '5',
    () => '[{"type":"auth-session"}]',
    () => JSON.stringify({ type: 'auth-session', sessionToken: 'x'.repeat(20_000) }),
  ];
  for (const [i, make] of bad.entries()) {
    const h = hooks();
    const dc = open(h);
    dc.deliver(make(dc.sent[0].nonce));
    await flush();
    assert.equal(dc.last().type, 'auth-failed', `case ${i}`);
    assert.equal(dc.last().reason, 'invalid_request', `case ${i}`);
    assert.ok(dc.closed, `case ${i} closed`);
    assert.equal(h.authenticated, 0, `case ${i}`);
    assert.deepEqual(h.errors, [], `case ${i}`);
  }
  assert.deepEqual(unhandled, []);
  // and the verifiers themselves no longer throw on a non-string
  assert.equal(verifyBackupCode(undefined, ['x']), -1);
});

test('a throwing or rejecting post-auth handler is logged; the channel keeps working', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const h = hooks();
  let calls = 0;
  h.onMessage = (m) => {
    calls++;
    if (m.id === 'throw') throw new Error('sync boom');
    if (m.id === 'reject') return Promise.reject(new Error('async boom'));
  };
  const dc = open(h);
  await loginFull(dc, generateTotp(cfg.totp.secret));
  dc.deliver({ type: 'rpc', id: 'throw' });
  dc.deliver({ type: 'rpc', id: 'reject' });
  dc.deliver('not json');
  dc.deliver({ type: 'rpc', id: 'ok' });
  await flush();
  assert.equal(calls, 3);
  assert.equal(h.errors.length, 2);
  assert.deepEqual(dc.sent.filter(m => m.type === 'error'), [{ type: 'error', message: 'Invalid JSON' }]);
  assert.ok(!dc.closed);
  assert.deepEqual(unhandled, []);
});

// ── 3. No stale-config write-back; reauth/reset revoke ──────────────────────

test('reauth while a login is pending: the old TOTP secret no longer works and nothing old is written back', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const h = hooks();
  const dc = open(h); // channel opened under the old secrets
  const { totpSecret } = reauth(); // owner runs reauth meanwhile
  const afterReauth = fs.readFileSync(CONFIG, 'utf8');

  const reply = await loginFull(dc, generateTotp(cfg.totp.secret)); // attacker's code for the OLD secret
  assert.deepEqual(reply, { type: 'auth-failed', reason: 'invalid_totp' });
  assert.equal(h.authenticated, 0);
  assert.equal(fs.readFileSync(CONFIG, 'utf8'), afterReauth, 'config untouched');

  const ok = await loginFull(dc, generateTotp(totpSecret));
  assert.equal(ok.type, 'auth-ok');
  assert.equal(fs.readFileSync(CONFIG, 'utf8'), afterReauth, 'a TOTP login writes nothing');
});

test('a backup code login removes only that code, from the config as it is on disk now', async () => {
  const { cfg, codes } = makeConfig();
  writeConfig(CONFIG, cfg);
  const h = hooks();
  const dc = open(h);
  updateConfig(CONFIG, (c) => { c.gatewayId = 'gw-changed-meanwhile'; }); // e.g. the service saved its id
  const reply = await loginFull(dc, codes[3].toLowerCase());
  assert.equal(reply.type, 'auth-ok');
  const disk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(disk.gatewayId, 'gw-changed-meanwhile');
  assert.equal(disk.backupCodeHashes.length, 9);
  assert.equal(verifyBackupCode(codes[3], disk.backupCodeHashes), -1);
  assert.equal(disk.totp.secret, cfg.totp.secret);

  const dc2 = open(hooks());
  assert.deepEqual(await loginFull(dc2, codes[3]), { type: 'auth-failed', reason: 'invalid_totp' }, 'one-time');
});

test('backup codes from before a reauth are dead', async () => {
  const { cfg, codes } = makeConfig();
  writeConfig(CONFIG, cfg);
  const dc = open(hooks());
  reauth();
  const before = fs.readFileSync(CONFIG, 'utf8');
  assert.deepEqual(await loginFull(dc, codes[0]), { type: 'auth-failed', reason: 'invalid_totp' });
  assert.equal(fs.readFileSync(CONFIG, 'utf8'), before);
});

test('session tokens from before a reauth are rejected; new ones work', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const oldToken = issueSessionToken(cfg.userId, cfg.google.authorizedSub, 7, cfg.sessionSecret);
  const dc = open(hooks());
  dc.deliver({ type: 'auth-session', sessionToken: oldToken });
  await flush();
  assert.equal(dc.last().type, 'auth-ok');

  reauth();
  const dc2 = open(hooks());
  dc2.deliver({ type: 'auth-session', sessionToken: oldToken });
  await flush();
  assert.deepEqual(dc2.last(), { type: 'auth-failed', reason: 'invalid_session' });

  const fresh = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const dc3 = open(hooks());
  dc3.deliver({ type: 'auth-session', sessionToken: issueSessionToken(fresh.userId, fresh.google.authorizedSub, 7, fresh.sessionSecret) });
  await flush();
  assert.equal(dc3.last().type, 'auth-ok');
});

test('reauth or reset signs out channels that logged in under the old secrets', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const h = hooks();
  const a = open(h);
  await loginFull(a, generateTotp(cfg.totp.secret));
  assert.equal(h.authenticated, 1);

  updateConfig(CONFIG, (c) => { c.backupCodeHashes = c.backupCodeHashes.slice(1); }); // unrelated change
  assert.deepEqual(revokeStaleChannels(readAuthConfig(CONFIG)), []);
  assert.ok(!a.closed);

  reauth();
  assert.deepEqual(revokeStaleChannels(readAuthConfig(CONFIG)), [a.id]);
  assert.deepEqual(a.last(), { type: 'auth-failed', reason: 'invalid_session' });
  assert.ok(a.closed);
  a.deliver({ type: 'rpc', id: 'after-revoke' });
  await flush();
  assert.equal(h.handled.length, 0);

  const fresh = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const b = open(h);
  b.deliver({ type: 'auth-session', sessionToken: issueSessionToken(fresh.userId, fresh.google.authorizedSub, 7, fresh.sessionSecret) });
  await flush();
  fs.rmSync(CONFIG); // reset
  assert.deepEqual(revokeStaleChannels(readAuthConfig(CONFIG)), [b.id]);
  assert.ok(b.closed);
});

// ── 4. Lockout survives a restart ────────────────────────────────────────────

test('the gateway-wide TOTP lockout and replay guard survive a restart', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  loadAuthState(STATE);
  const h = hooks();
  const dc = open(h);
  for (let i = 0; i < 5; i++) await loginFull(dc, '000000' === generateTotp(cfg.totp.secret) ? '111111' : '000000');
  assert.deepEqual(h.failures, ['invalid_totp', 'invalid_totp', 'invalid_totp', 'invalid_totp', 'invalid_totp']);
  assert.deepEqual(dc.last(), { type: 'auth-failed', reason: 'rate_limited' });
  assert.ok(dc.closed, '5 failures close the channel');
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.ok(saved.lockedUntil > Date.now());
  assert.equal((fs.statSync(STATE).mode & 0o777), 0o600);

  _resetAuthForTests(); // restart
  loadAuthState(STATE);
  const dc2 = open(hooks());
  assert.deepEqual(await loginFull(dc2, generateTotp(cfg.totp.secret)), { type: 'auth-failed', reason: 'rate_limited' });

  // lockout over: a correct code works, and can't be replayed after another restart
  fs.writeFileSync(STATE, JSON.stringify({ ...saved, lockedUntil: 0 }));
  _resetAuthForTests();
  loadAuthState(STATE);
  const code = generateTotp(cfg.totp.secret);
  assert.equal((await loginFull(open(hooks()), code)).type, 'auth-ok');
  _resetAuthForTests();
  loadAuthState(STATE);
  assert.deepEqual(await loginFull(open(hooks()), code), { type: 'auth-failed', reason: 'invalid_totp' });
});

test('a corrupt lockout file starts fresh instead of failing', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  fs.writeFileSync(STATE, '{"lockedUntil": "soon"');
  loadAuthState(STATE);
  assert.equal((await loginFull(open(hooks()), generateTotp(cfg.totp.secret))).type, 'auth-ok');
});

// ── 5. Unauthenticated channel cap + 60 s timeout ────────────────────────────

test(`at most ${MAX_PENDING_CHANNELS} channels wait to log in; each is closed after ${AUTH_TIMEOUT_MS / 1000} s`, async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const h = hooks();
  const authed = open(h);
  await loginFull(authed, generateTotp(cfg.totp.secret));

  const pending = Array.from({ length: MAX_PENDING_CHANNELS }, () => open(h));
  assert.ok(pending.every(dc => dc.sent[0].type === 'auth-required' && !dc.closed));
  const extra = open(h);
  assert.deepEqual(extra.sent, [{ type: 'auth-failed', reason: 'rate_limited' }]);
  assert.ok(extra.closed);

  pending[0].close(); // a browser goes away: its slot frees up
  const refill = open(h);
  assert.equal(refill.sent[0].type, 'auth-required');

  mock.timers.tick(AUTH_TIMEOUT_MS - 1);
  assert.ok(!refill.closed);
  mock.timers.tick(1);
  for (const dc of [...pending.slice(1), refill]) {
    assert.deepEqual(dc.last(), { type: 'auth-failed', reason: 'auth_timeout' });
    assert.ok(dc.closed);
  }
  assert.ok(!authed.closed, 'a logged-in channel is not timed out');
  assert.equal(open(h).sent[0].type, 'auth-required', 'slots free again');
});
