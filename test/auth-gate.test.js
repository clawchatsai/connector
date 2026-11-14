// Login gate for browser DataChannels (src/auth-handler.ts, device keys), driven with fake channels
// and a real config.json on disk. Runs against the build (npm test runs tsc first).
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachBrowserChannel, revokeStaleChannels, loadAuthState, _resetAuthForTests,
  MAX_PENDING_CHANNELS, AUTH_TIMEOUT_MS,
} from '../dist/auth-handler.js';
import {
  readAuthConfig, removeBackupCode, updateConfig, writeConfig, addDevice, removeDevices, touchDevice, MAX_DEVICES,
} from '../dist/config-store.js';
import { generateTotpSecret, generateTotp, generateBackupCodes } from '../dist/totp.js';
import { generateSessionSecret } from '../dist/session-token.js';
import { loadOrCreatePeerKey } from '../server/peer/keys.js';
import { makeBrowser, bindingOf, connectorProofOk, deviceLogin, pairMsg, FP_A, FP_B } from './helpers/browser.js';

let dir, CONFIG, STATE, KEY, n = 0;
const unhandled = [];
const onUnhandled = (e) => unhandled.push(e);
const DTLS = { browser: FP_A, connector: FP_B };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-auth-'));
  CONFIG = path.join(dir, 'config.json');
  STATE = path.join(dir, 'auth-state.json');
  KEY = loadOrCreatePeerKey(dir);
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
    totp: { secret: generateTotpSecret(), algorithm: 'SHA1', digits: 6, period: 30, enabledAt: '2026-01-01T00:00:00Z' },
    sessionSecret: generateSessionSecret(),
    backupCodeHashes: hashes,
    ...over,
  };
  return { cfg, codes };
}

/** What `openclaw clawchats reauth` writes: new TOTP + session secret + backup codes, no devices. */
function reauth() {
  const { codes, hashes } = generateBackupCodes();
  const totpSecret = generateTotpSecret();
  updateConfig(CONFIG, (c) => {
    c.totp = { ...c.totp, secret: totpSecret };
    c.sessionSecret = generateSessionSecret();
    c.backupCodeHashes = hashes;
    c.devices = [];
  });
  return { totpSecret, codes };
}

function hooks() {
  const h = {
    handled: [], authenticated: [], failures: [], errors: [],
    loadAuthConfig: () => readAuthConfig(CONFIG),
    consumeBackupCode: (hash) => removeBackupCode(CONFIG, hash),
    connectorKey: KEY,
    addDevice: (d, secret) => addDevice(CONFIG, d, secret),
    touchDevice: (id) => touchDevice(CONFIG, id),
    onAuthenticated: (info) => { h.authenticated.push(info); },
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

function open(h, dtls = DTLS) {
  const dc = fakeDc();
  dc.id = `conn_${++n}`;
  attachBrowserChannel(dc, dc.id, h, dtls);
  dc.binding = dc.sent[0]?.type === 'auth-required' ? bindingOf(dc.sent[0], dc.id, dtls ?? DTLS) : null;
  return dc;
}

async function send(dc, msg) {
  dc.deliver(msg);
  await flush();
  return dc.last();
}

async function pair(dc, browser, cfg, over = {}) {
  return send(dc, pairMsg(browser, dc.binding, generateTotp(cfg.totp.secret), 'totp', over.label ?? browser.label));
}

/** A config with one device already paired. */
function pairedSetup() {
  const { cfg, codes } = makeConfig();
  writeConfig(CONFIG, cfg);
  const browser = makeBrowser('Chrome on Windows');
  const now = new Date().toISOString();
  assert.equal(addDevice(CONFIG, { deviceId: browser.deviceId, pubkey: browser.pub, label: browser.label, createdAt: now, lastSeen: now }, cfg.totp.secret), 'ok');
  return { cfg, codes, browser };
}

// ── 0. auth-required ─────────────────────────────────────────────────────────

test('auth-required carries authVersion 2, a nonce and the connector key, signed over this channel', () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const dc = open(hooks());
  const m = dc.sent[0];
  assert.equal(m.type, 'auth-required');
  assert.equal(m.authVersion, 2);
  assert.match(m.nonce, /^[0-9a-f]{64}$/);
  assert.equal(m.connectorKey, KEY.publicKey);
  assert.ok(connectorProofOk(m, dc.binding), 'a browser with the same view of the channel accepts the proof');
  assert.ok(!connectorProofOk(m, { ...dc.binding, connectorFp: 'C3'.repeat(32) }), 'a different connector fingerprint is refused');
  assert.ok(!connectorProofOk(m, { ...dc.binding, browserFp: 'C3'.repeat(32) }), 'a different browser fingerprint is refused');
  assert.ok(!connectorProofOk(m, { ...dc.binding, nonce: '00'.repeat(32) }));
  assert.ok(!connectorProofOk(m, { ...dc.binding, connectionId: 'conn_other' }));
  assert.ok(!connectorProofOk({ ...m, connectorKey: loadOrCreatePeerKey(fs.mkdtempSync(path.join(dir, 'k-'))).publicKey }, dc.binding), 'another key');
  assert.notEqual(open(hooks()).sent[0].nonce, m.nonce, 'fresh nonce per channel');
});

test('a channel without both DTLS fingerprints cannot be bound and is refused', () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  for (const dtls of [null, { browser: '', connector: FP_B }, { browser: FP_A, connector: '' }]) {
    const dc = open(hooks(), dtls);
    assert.deepEqual(dc.sent, [{ type: 'auth-failed', reason: 'no_channel_binding' }]);
    assert.ok(dc.closed);
  }
});

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
    'v2 with devices that are not a list': JSON.stringify({ ...cfg, devices: { a: 1 } }),
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
    assert.equal(h.authenticated.length, 0, name);
  }
});

test('config deleted (reset) while a login is pending: refused, not let in', async () => {
  const { browser } = pairedSetup();
  const h = hooks();
  const dc = open(h);
  fs.rmSync(CONFIG);
  const reply = await send(dc, deviceLogin(browser, dc.binding));
  assert.equal(reply.type, 'auth-required-setup');
  assert.ok(dc.closed);
  assert.equal(h.authenticated.length, 0);
});

test('nothing but auth messages is handled before login; queued messages follow the login in order', async () => {
  const { browser } = pairedSetup();
  const h = hooks();
  const dc = open(h);
  dc.deliver({ type: 'rpc', id: 'early', method: 'GET', url: '/api/settings' });
  dc.deliver({ type: 'gateway-msg', payload: '{}' });
  dc.deliver({ type: 'ping' });
  await flush();
  assert.equal(h.handled.length, 0);
  assert.ok(!dc.closed);
  dc.deliver(deviceLogin(browser, dc.binding));
  dc.deliver({ type: 'rpc', id: 'after-1' });
  dc.deliver({ type: 'rpc', id: 'after-2' });
  await flush();
  assert.equal(dc.sent.find(m => m.type === 'auth-ok')?.type, 'auth-ok');
  assert.deepEqual(h.handled.map(m => m.id), ['after-1', 'after-2']);
});

// ── 2. Malformed pre-auth messages never throw ──────────────────────────────

test('bad fields / bad JSON: channel closed, nothing thrown or left unhandled', async () => {
  const { browser } = pairedSetup();
  const b = makeBrowser();
  const okPair = (binding) => pairMsg(b, binding, '123456');
  const bad = [
    (bd) => ({ ...deviceLogin(browser, bd), deviceId: 12 }),
    (bd) => ({ ...deviceLogin(browser, bd), deviceId: 'zz' }),
    (bd) => ({ ...deviceLogin(browser, bd), deviceId: { $ne: 1 } }),
    (bd) => ({ ...deviceLogin(browser, bd), sig: 42 }),
    (bd) => ({ ...deviceLogin(browser, bd), sig: 'A'.repeat(500) }),
    (bd) => ({ type: 'auth-device' }),
    (bd) => ({ ...okPair(bd), devicePub: 'not a key' }),
    (bd) => ({ ...okPair(bd), devicePub: 12 }),
    (bd) => ({ ...okPair(bd), label: '' }),
    (bd) => ({ ...okPair(bd), label: '   ' }),
    (bd) => ({ ...okPair(bd), label: 'x'.repeat(65) }),
    (bd) => ({ ...okPair(bd), label: ['a'] }),
    (bd) => ({ ...okPair(bd), kind: 'password' }),
    (bd) => ({ ...okPair(bd), proof: 'abc' }),
    (bd) => ({ ...okPair(bd), proof: 123456 }),
    (bd) => ({ ...okPair(bd), sig: null }),
    () => ({ type: 'auth-pair' }),
    () => '{"type":"auth-device",',
    () => 'null',
    () => '5',
    () => '[{"type":"auth-device"}]',
    () => JSON.stringify({ type: 'auth-device', deviceId: 'a'.repeat(20_000) }),
  ];
  for (const [i, make] of bad.entries()) {
    const h = hooks();
    const dc = open(h);
    dc.deliver(make(dc.binding));
    await flush();
    assert.equal(dc.last().type, 'auth-failed', `case ${i}`);
    assert.equal(dc.last().reason, 'invalid_request', `case ${i}`);
    assert.ok(dc.closed, `case ${i} closed`);
    assert.equal(h.authenticated.length, 0, `case ${i}`);
    assert.deepEqual(h.errors, [], `case ${i}`);
  }
  assert.deepEqual(unhandled, []);
});

test('a throwing or rejecting post-auth handler is logged; the channel keeps working', async () => {
  const { browser } = pairedSetup();
  const h = hooks();
  let calls = 0;
  h.onMessage = (m) => {
    calls++;
    if (m.id === 'throw') throw new Error('sync boom');
    if (m.id === 'reject') return Promise.reject(new Error('async boom'));
  };
  const dc = open(h);
  await send(dc, deviceLogin(browser, dc.binding));
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

// ── 3. The old login is never honoured ───────────────────────────────────────

test('auth-session and auth-full (old frontend): refused with a reload message, never logged in', async () => {
  const { cfg } = pairedSetup();
  for (const msg of [
    { type: 'auth-session', sessionToken: 'a.b.c' },
    { type: 'auth-full', idToken: 'signaling-verified', totp: generateTotp(cfg.totp.secret), nonce: 'x', sessionDays: 7 },
    { type: 'auth-full', idToken: 'dev-mode-no-google', totp: generateTotp(cfg.totp.secret) },
  ]) {
    const h = hooks();
    const dc = open(h);
    dc.deliver(msg);
    await flush();
    assert.equal(dc.last().type, 'auth-required-setup', msg.type); // the one message an old app renders as text
    assert.match(dc.last().message, /Reload the page/);
    assert.ok(dc.closed);
    assert.equal(h.authenticated.length, 0);
    assert.equal(h.handled.length, 0);
    assert.equal(h.failures.length, 0, 'not counted as a failed login');
  }
});

// ── 4. Pairing ───────────────────────────────────────────────────────────────

test('pairing with a TOTP code stores the device; the next channel logs in without any code', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const browser = makeBrowser('Firefox on Linux');
  const h = hooks();
  const dc = open(h);
  const reply = await pair(dc, browser, cfg);
  assert.deepEqual(reply, { type: 'auth-ok', deviceId: browser.deviceId, label: 'Firefox on Linux', paired: true });
  assert.deepEqual(h.authenticated, [{ deviceId: browser.deviceId, label: 'Firefox on Linux', paired: true }]);
  const disk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(disk.devices.length, 1);
  assert.deepEqual(Object.keys(disk.devices[0]).sort(), ['createdAt', 'deviceId', 'label', 'lastSeen', 'pubkey']);
  assert.equal(disk.devices[0].pubkey, browser.pub);
  assert.equal(disk.totp.secret, cfg.totp.secret, 'the rest of the config is untouched');
  assert.equal(disk.userId, 'user-1');
  assert.equal((fs.statSync(CONFIG).mode & 0o777), 0o600);

  // later: a new channel, a fresh nonce, only a signature
  const h2 = hooks();
  const dc2 = open(h2);
  assert.notEqual(dc2.sent[0].nonce, dc.sent[0].nonce);
  const ok = await send(dc2, deviceLogin(browser, dc2.binding));
  assert.deepEqual(ok, { type: 'auth-ok', deviceId: browser.deviceId, label: 'Firefox on Linux', paired: false });
  assert.equal(h2.authenticated[0].paired, false);
  dc2.deliver({ type: 'rpc', id: 'hello' });
  await flush();
  assert.deepEqual(h2.handled.map(m => m.id), ['hello']);
});

test('pairing with a backup code consumes it', async () => {
  const { cfg, codes } = makeConfig();
  writeConfig(CONFIG, cfg);
  const browser = makeBrowser();
  const dc = open(hooks());
  updateConfig(CONFIG, (c) => { c.gatewayId = 'gw-changed-meanwhile'; }); // e.g. the service saved its id
  const reply = await send(dc, pairMsg(browser, dc.binding, codes[3].toLowerCase(), 'backup'));
  assert.equal(reply.type, 'auth-ok');
  const disk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(disk.gatewayId, 'gw-changed-meanwhile', 'the config as it is on disk now, not a stale copy');
  assert.equal(disk.backupCodeHashes.length, 9);
  assert.equal(disk.devices.length, 1);

  const other = makeBrowser();
  const dc2 = open(hooks());
  assert.deepEqual(await send(dc2, pairMsg(other, dc2.binding, codes[3], 'backup')), { type: 'auth-failed', reason: 'invalid_code' }, 'one-time');
});

test('a wrong code, a code for another kind, or an old secret does not pair', async () => {
  const { cfg, codes } = makeConfig();
  writeConfig(CONFIG, cfg);
  const browser = makeBrowser();
  const h = hooks();
  const dc = open(h);
  const wrong = generateTotp(cfg.totp.secret) === '000000' ? '111111' : '000000';
  assert.deepEqual(await send(dc, pairMsg(browser, dc.binding, wrong)), { type: 'auth-failed', reason: 'invalid_code' });
  assert.deepEqual(await send(dc, pairMsg(browser, dc.binding, codes[0], 'totp')), { type: 'auth-failed', reason: 'invalid_code' }, 'backup code as a TOTP');
  assert.deepEqual(await send(dc, pairMsg(browser, dc.binding, generateTotp(cfg.totp.secret), 'backup')), { type: 'auth-failed', reason: 'invalid_code' }, 'TOTP as a backup code');
  assert.deepEqual(await send(dc, pairMsg(browser, dc.binding, generateTotp(generateTotpSecret()))), { type: 'auth-failed', reason: 'invalid_code' }, 'another secret');
  assert.equal(h.authenticated.length, 0);
  assert.deepEqual(h.failures, ['invalid_code', 'invalid_code', 'invalid_code', 'invalid_code']);
  assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).devices, undefined);
});

test('a pairing proof made for another channel does not verify (code relayed across a MITM leg)', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const browser = makeBrowser();
  const code = generateTotp(cfg.totp.secret);
  // The browser pairs on leg 1 (its fingerprints A / M1); a relay forwards the message to the real
  // connector, whose channel has other fingerprints (M2 / B).
  const leg1 = { nonce: '11'.repeat(32), connectionId: 'conn_x', browserFp: FP_A, connectorFp: 'D4'.repeat(32), connectorPub: 'MITM-KEY' };
  const relayed = pairMsg(browser, leg1, code);
  const h = hooks();
  const dc = open(h);
  assert.deepEqual(await send(dc, relayed), { type: 'auth-failed', reason: 'invalid_signature' });
  assert.equal(h.authenticated.length, 0);
  // Even re-signing the message does not help the relay: the proof binds the code to leg 1.
  const resigned = { ...relayed, sig: browser.sign(JSON.stringify(['clawchats-auth-v2', 'pair', dc.binding.nonce, dc.binding.connectionId, FP_A, FP_B, dc.binding.connectorPub, browser.pub, browser.label])) };
  assert.deepEqual(await send(dc, resigned), { type: 'auth-failed', reason: 'invalid_code' });
  assert.equal(h.authenticated.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).devices, undefined);
});

test('a pairing message cannot be changed or replayed: device key, label, nonce', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const browser = makeBrowser('Mine');
  const attacker = makeBrowser('Attacker');
  const code = generateTotp(cfg.totp.secret);
  const dc = open(hooks());
  const msg = pairMsg(browser, dc.binding, code);
  // swap the device key for the attacker's (keeping proof and signature): signature no longer matches
  assert.deepEqual(await send(dc, { ...msg, devicePub: attacker.pub }), { type: 'auth-failed', reason: 'invalid_signature' });
  // change the label
  assert.deepEqual(await send(dc, { ...msg, label: 'Totally legit' }), { type: 'auth-failed', reason: 'invalid_signature' });
  // the attacker signs the right transcript for their key but cannot make the code proof
  const forged = pairMsg(attacker, dc.binding, '000000');
  assert.deepEqual(await send(dc, { ...forged }), { type: 'auth-failed', reason: 'invalid_code' });
  // replay on a new channel (new nonce)
  const dc2 = open(hooks());
  assert.deepEqual(await send(dc2, msg), { type: 'auth-failed', reason: 'invalid_signature' });
  // the genuine message still works on its own channel
  assert.equal((await send(dc, msg)).type, 'auth-ok');
});

test('a TOTP code pairs only once (replay guard), also across a restart', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  loadAuthState(STATE);
  const code = generateTotp(cfg.totp.secret);
  const a = makeBrowser(), b = makeBrowser();
  const dca = open(hooks());
  assert.equal((await send(dca, pairMsg(a, dca.binding, code))).type, 'auth-ok');
  const dcb = open(hooks());
  assert.deepEqual(await send(dcb, pairMsg(b, dcb.binding, code)), { type: 'auth-failed', reason: 'invalid_code' });
  _resetAuthForTests(); // restart
  loadAuthState(STATE);
  const dcb2 = open(hooks());
  assert.deepEqual(await send(dcb2, pairMsg(b, dcb2.binding, code)), { type: 'auth-failed', reason: 'invalid_code' });
});

test(`at most ${MAX_DEVICES} browsers pair; re-pairing a known one is fine`, async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const now = new Date().toISOString();
  const known = Array.from({ length: MAX_DEVICES }, (_, i) => makeBrowser(`b${i}`));
  for (const b of known) addDevice(CONFIG, { deviceId: b.deviceId, pubkey: b.pub, label: b.label, createdAt: now, lastSeen: now }, cfg.totp.secret);
  const extra = makeBrowser('one too many');
  const h = hooks();
  const dc = open(h);
  assert.deepEqual(await pair(dc, extra, cfg), { type: 'auth-failed', reason: 'too_many_devices' });
  assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).devices.length, MAX_DEVICES);
  // a known device may pair again (new code, new label)
  const again = open(hooks());
  const code = generateTotp(cfg.totp.secret);
  assert.equal(readAuthConfig(CONFIG).config.devices.length, MAX_DEVICES);
  assert.equal((await send(again, pairMsg(known[0], again.binding, code, 'totp', 'renamed'))).type, 'auth-ok');
  const disk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(disk.devices.length, MAX_DEVICES);
  assert.equal(disk.devices.find(d => d.deviceId === known[0].deviceId).label, 'renamed');
  assert.equal(disk.devices.find(d => d.deviceId === known[0].deviceId).createdAt, now, 'createdAt kept');
});

// ── 5. Device login: what is bound, what is refused ──────────────────────────

test('a tampered binding is refused: fingerprints, nonce, connection id, connector key, device key', async () => {
  const { browser } = pairedSetup();
  const other = makeBrowser();
  const dc0 = open(hooks());
  const base = dc0.binding;
  const variants = {
    'browser fingerprint': { ...base, browserFp: 'E5'.repeat(32) },
    'connector fingerprint': { ...base, connectorFp: 'E5'.repeat(32) },
    'swapped fingerprints': { ...base, browserFp: base.connectorFp, connectorFp: base.browserFp },
    nonce: { ...base, nonce: 'ab'.repeat(32) },
    'connection id': { ...base, connectionId: 'conn_somewhere_else' },
    'connector key': { ...base, connectorPub: other.pub },
  };
  for (const [name, binding] of Object.entries(variants)) {
    const h = hooks();
    const dc = open(h);
    const reply = await send(dc, deviceLogin(browser, binding));
    assert.deepEqual(reply, { type: 'auth-failed', reason: 'invalid_signature' }, name);
    assert.equal(h.authenticated.length, 0, name);
    assert.ok(!dc.closed, name);
  }
  // signed by another key but claiming this device
  const h = hooks();
  const dc = open(h);
  assert.deepEqual(await send(dc, { ...deviceLogin(other, dc.binding), deviceId: browser.deviceId }), { type: 'auth-failed', reason: 'invalid_signature' });
  // a signature made for the 'pair' or 'connector' role never counts as a login
  const t = JSON.stringify(['clawchats-auth-v2', 'pair', dc.binding.nonce, dc.binding.connectionId, FP_A, FP_B, dc.binding.connectorPub, browser.pub, '']);
  assert.deepEqual(await send(dc, { type: 'auth-device', deviceId: browser.deviceId, sig: browser.sign(t) }), { type: 'auth-failed', reason: 'invalid_signature' });
  // domain separation: a signature over the bare nonce
  assert.deepEqual(await send(dc, { type: 'auth-device', deviceId: browser.deviceId, sig: browser.sign(dc.binding.nonce) }), { type: 'auth-failed', reason: 'invalid_signature' });
  assert.equal(h.authenticated.length, 0);
});

test('a signature replayed on a new channel (new nonce) is refused', async () => {
  const { browser } = pairedSetup();
  const dc1 = open(hooks());
  const login = deviceLogin(browser, dc1.binding);
  assert.equal((await send(dc1, login)).type, 'auth-ok');
  const h = hooks();
  const dc2 = open(h);
  assert.deepEqual(await send(dc2, login), { type: 'auth-failed', reason: 'invalid_signature' });
  assert.equal(h.authenticated.length, 0);
  // not even with the first channel's nonce echoed
  assert.deepEqual(await send(dc2, { ...login, nonce: dc1.sent[0].nonce }), { type: 'auth-failed', reason: 'invalid_signature' });
});

test('relay simulation: a login made on the browser<->relay leg does not work on the relay<->connector leg', async () => {
  const { browser } = pairedSetup();
  // Leg 1 (browser <-> relay): fingerprints (A, M1). Leg 2 (relay <-> connector): (M2, B).
  const leg2 = { browser: 'F6'.repeat(32), connector: FP_B };
  const h = hooks();
  const dc = open(h, leg2); // the connector's channel
  // The relay shows the browser the connector's auth-required; the browser (whose view is leg 1)
  // rejects the connector's proof, so it never answers:
  const browserView = bindingOf(dc.sent[0], dc.id, { browser: FP_A, connector: 'F7'.repeat(32) });
  assert.ok(!connectorProofOk(dc.sent[0], browserView), 'the browser refuses the relayed connector proof');
  // A relay that answers for the browser needs the device key. Replaying what the browser would have signed fails:
  const browsersAnswer = deviceLogin(browser, browserView);
  assert.deepEqual(await send(dc, browsersAnswer), { type: 'auth-failed', reason: 'invalid_signature' });
  assert.equal(h.authenticated.length, 0);
  // Without a relay all views agree and it verifies
  const sameFp = open(hooks(), { browser: FP_A, connector: FP_B });
  assert.ok(connectorProofOk(sameFp.sent[0], bindingOf(sameFp.sent[0], sameFp.id, { browser: FP_A, connector: FP_B })));
});

test('unknown device without a code is refused; the channel stays open for pairing', async () => {
  const { cfg } = pairedSetup();
  const stranger = makeBrowser('Stranger');
  const h = hooks();
  const dc = open(h);
  assert.deepEqual(await send(dc, deviceLogin(stranger, dc.binding)), { type: 'auth-failed', reason: 'unknown_device' });
  assert.equal(h.authenticated.length, 0);
  assert.ok(!dc.closed);
  assert.deepEqual(h.failures, [], 'not a wrong guess, not counted globally');
  dc.deliver({ type: 'rpc', id: 'x' });
  await flush();
  assert.equal(h.handled.length, 0);
  // then it may pair
  assert.equal((await pair(dc, stranger, cfg)).type, 'auth-ok');
});

test('five failures on one channel close it', async () => {
  const { browser } = pairedSetup();
  const dc = open(hooks());
  const bad = deviceLogin(browser, { ...dc.binding, nonce: 'cd'.repeat(32) });
  for (let i = 0; i < 4; i++) assert.equal((await send(dc, bad)).reason, 'invalid_signature');
  assert.deepEqual(await send(dc, bad), { type: 'auth-failed', reason: 'rate_limited' });
  assert.ok(dc.closed);
});

// ── 6. Revocation ────────────────────────────────────────────────────────────

test('revoking a device closes its live channel at once and it cannot log in again', async () => {
  const { browser } = pairedSetup();
  const keep = makeBrowser('Keeps');
  const now = new Date().toISOString();
  addDevice(CONFIG, { deviceId: keep.deviceId, pubkey: keep.pub, label: keep.label, createdAt: now, lastSeen: now }, readAuthConfig(CONFIG).config.totp.secret);
  const h = hooks();
  const a = open(h), b = open(h);
  assert.equal((await send(a, deviceLogin(browser, a.binding))).type, 'auth-ok');
  assert.equal((await send(b, deviceLogin(keep, b.binding))).type, 'auth-ok');

  assert.deepEqual(revokeStaleChannels(readAuthConfig(CONFIG)), [], 'nothing changed');
  updateConfig(CONFIG, (c) => { c.backupCodeHashes = c.backupCodeHashes.slice(1); }); // unrelated change
  assert.deepEqual(revokeStaleChannels(readAuthConfig(CONFIG)), []);

  const removed = removeDevices(CONFIG, d => d.deviceId === browser.deviceId);
  assert.equal(removed.length, 1);
  assert.deepEqual(revokeStaleChannels(readAuthConfig(CONFIG)), [a.id]);
  assert.deepEqual(a.last(), { type: 'auth-failed', reason: 'device_revoked' });
  assert.ok(a.closed);
  assert.ok(!b.closed, 'other devices stay');
  a.deliver({ type: 'rpc', id: 'after-revoke' });
  await flush();
  assert.deepEqual(h.handled, []);

  const again = open(hooks());
  assert.deepEqual(await send(again, deviceLogin(browser, again.binding)), { type: 'auth-failed', reason: 'unknown_device' });
});

test('reauth unpairs everyone; reset (no config) signs everyone out', async () => {
  const { browser, cfg } = pairedSetup();
  const h = hooks();
  const a = open(h);
  await send(a, deviceLogin(browser, a.binding));
  const { totpSecret } = reauth();
  assert.deepEqual(revokeStaleChannels(readAuthConfig(CONFIG)), [a.id]);
  assert.ok(a.closed);

  // the old device is gone and the old secret is dead; pairing with the new secret works
  const b = open(hooks());
  assert.deepEqual(await send(b, deviceLogin(browser, b.binding)), { type: 'auth-failed', reason: 'unknown_device' });
  assert.deepEqual(await send(b, pairMsg(browser, b.binding, generateTotp(cfg.totp.secret))), { type: 'auth-failed', reason: 'invalid_code' });
  assert.equal((await send(b, pairMsg(browser, b.binding, generateTotp(totpSecret)))).type, 'auth-ok');

  fs.rmSync(CONFIG); // reset
  assert.deepEqual(revokeStaleChannels(readAuthConfig(CONFIG)), [b.id]);
  assert.ok(b.closed);
});

test('reauth between the code check and the save does not pair the device under the new secret', () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  reauth();
  const b = makeBrowser();
  const now = new Date().toISOString();
  assert.equal(addDevice(CONFIG, { deviceId: b.deviceId, pubkey: b.pub, label: 'x', createdAt: now, lastSeen: now }, cfg.totp.secret), 'stale');
  assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).devices, []);
});

// ── 7. Lockout survives a restart ────────────────────────────────────────────

test('failed pairings lock pairing gateway-wide; the lockout and replay guard survive a restart', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  loadAuthState(STATE);
  const h = hooks();
  const browser = makeBrowser();
  const wrong = generateTotp(cfg.totp.secret) === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const dc = open(h);
    await send(dc, pairMsg(browser, dc.binding, wrong));
  }
  assert.deepEqual(h.failures, Array(5).fill('invalid_code'));
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.ok(saved.lockedUntil > Date.now());
  assert.equal((fs.statSync(STATE).mode & 0o777), 0o600);

  // locked: even the right code is not looked at
  const locked = open(hooks());
  assert.deepEqual(await send(locked, pairMsg(browser, locked.binding, generateTotp(cfg.totp.secret))), { type: 'auth-failed', reason: 'rate_limited' });

  _resetAuthForTests(); // restart
  loadAuthState(STATE);
  const dc2 = open(hooks());
  assert.deepEqual(await send(dc2, pairMsg(browser, dc2.binding, generateTotp(cfg.totp.secret))), { type: 'auth-failed', reason: 'rate_limited' });

  // lockout over: the right code works, and can't be replayed after another restart
  fs.writeFileSync(STATE, JSON.stringify({ ...saved, lockedUntil: 0 }));
  _resetAuthForTests();
  loadAuthState(STATE);
  const code = generateTotp(cfg.totp.secret);
  const dc3 = open(hooks());
  assert.equal((await send(dc3, pairMsg(browser, dc3.binding, code))).type, 'auth-ok');
  _resetAuthForTests();
  loadAuthState(STATE);
  const dc4 = open(hooks());
  assert.deepEqual(await send(dc4, pairMsg(makeBrowser(), dc4.binding, code)), { type: 'auth-failed', reason: 'invalid_code' });
});

test('failed device signatures count towards the same lockout; a valid signature still gets in', async () => {
  const { cfg, browser } = pairedSetup();
  loadAuthState(STATE);
  const h = hooks();
  for (let i = 0; i < 5; i++) {
    const dc = open(h);
    await send(dc, deviceLogin(browser, { ...dc.binding, nonce: 'ee'.repeat(32) }));
  }
  assert.deepEqual(h.failures, Array(5).fill('invalid_signature'));
  assert.ok(JSON.parse(fs.readFileSync(STATE, 'utf8')).lockedUntil > Date.now());
  // pairing (code guessing) is locked ...
  const stranger = makeBrowser();
  const p = open(hooks());
  assert.deepEqual(await send(p, pairMsg(stranger, p.binding, generateTotp(cfg.totp.secret))), { type: 'auth-failed', reason: 'rate_limited' });
  // ... but a signature cannot be guessed, so the real device is not locked out by someone else's noise
  const ok = open(hooks());
  assert.equal((await send(ok, deviceLogin(browser, ok.binding))).type, 'auth-ok');
});

test('a corrupt lockout file starts fresh instead of failing', async () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  fs.writeFileSync(STATE, '{"lockedUntil": "soon"');
  loadAuthState(STATE);
  const dc = open(hooks());
  assert.equal((await pair(dc, makeBrowser(), cfg)).type, 'auth-ok');
});

// ── 8. last seen, config races ───────────────────────────────────────────────

test("a device login updates only that device's lastSeen, on the config as it is on disk now", async () => {
  const { browser } = pairedSetup();
  const h = hooks();
  const dc = open(h);
  updateConfig(CONFIG, (c) => { c.devices[0].lastSeen = '2020-01-01T00:00:00.000Z'; c.gatewayId = 'changed-meanwhile'; });
  await send(dc, deviceLogin(browser, dc.binding));
  const disk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.notEqual(disk.devices[0].lastSeen, '2020-01-01T00:00:00.000Z');
  assert.equal(disk.gatewayId, 'changed-meanwhile');
  assert.equal(disk.devices.length, 1);
});

test('device writes re-read the config; unrelated changes are never undone', () => {
  const { cfg } = makeConfig();
  writeConfig(CONFIG, cfg);
  const now = new Date().toISOString();
  const bs = Array.from({ length: 6 }, (_, i) => makeBrowser(`b${i}`));
  for (const [i, b] of bs.entries()) {
    assert.equal(addDevice(CONFIG, { deviceId: b.deviceId, pubkey: b.pub, label: b.label, createdAt: now, lastSeen: now }, cfg.totp.secret), 'ok');
    updateConfig(CONFIG, (c) => { c.gatewayId = `gw-${i}`; });
  }
  removeDevices(CONFIG, d => d.label === 'b2');
  touchDevice(CONFIG, bs[3].deviceId, '2030-01-01T00:00:00.000Z');
  const disk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.deepEqual(disk.devices.map(d => d.label), ['b0', 'b1', 'b3', 'b4', 'b5']);
  assert.equal(disk.devices.find(d => d.label === 'b3').lastSeen, '2030-01-01T00:00:00.000Z');
  assert.equal(disk.gatewayId, 'gw-5');
  assert.equal(disk.totp.secret, cfg.totp.secret);
  // a device entry with a key that doesn't match its id, or not a key at all, can't log in
  fs.writeFileSync(CONFIG, JSON.stringify({ ...disk, devices: [...disk.devices, { ...disk.devices[0], deviceId: 'f'.repeat(32) }, { deviceId: 'a'.repeat(32), pubkey: 'x', label: 'bad', createdAt: now, lastSeen: now }, 'junk'] }));
  assert.equal(readAuthConfig(CONFIG).config.devices.length, 5);
});

// ── 9. Unauthenticated channel cap + 60 s timeout ────────────────────────────

test(`at most ${MAX_PENDING_CHANNELS} channels wait to log in; each is closed after ${AUTH_TIMEOUT_MS / 1000} s`, async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { browser } = pairedSetup();
  const h = hooks();
  const authed = open(h);
  await send(authed, deviceLogin(browser, authed.binding));

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
