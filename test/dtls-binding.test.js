// The channel binding with real DTLS: two real WebRTC peer connections (node-datachannel) over
// loopback, the connector side being the real WebRTCPeerManager and login gate. Proves that
//  - browser and connector read identical fingerprints from their SDPs (ordering/normalisation),
//  - a login works end to end over the real DataChannel,
//  - a relay that terminates DTLS separately on each side (what a malicious signaling server
//    would have to do to read the traffic) cannot get a login through, in either direction.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sdpFingerprint } from '../dist/channel-binding.js';
import { attachBrowserChannel, _resetAuthForTests } from '../dist/auth-handler.js';
import { readAuthConfig, writeConfig, addDevice, updateConfig, touchDevice, removeBackupCode } from '../dist/config-store.js';
import { generateTotpSecret, generateBackupCodes } from '../dist/totp.js';
import { generateSessionSecret } from '../dist/session-token.js';
import { loadOrCreatePeerKey } from '../server/peer/keys.js';
import { makeBrowser, bindingOf, connectorProofOk, deviceLogin } from './helpers/browser.js';

// The native module may be missing (no prebuild for this machine): skip, don't fail.
let RTCPeerConnection, nodeDataChannel, WebRTCPeerManager;
try {
  ({ RTCPeerConnection } = await import('node-datachannel/polyfill'));
  nodeDataChannel = (await import('node-datachannel')).default;
  ({ WebRTCPeerManager } = await import('../dist/webrtc-peer.js'));
} catch { /* skipped below */ }
const opts = { skip: !RTCPeerConnection && 'node-datachannel is not available on this machine' };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dtls-'));
const CONFIG = path.join(dir, 'config.json');
const KEY = loadOrCreatePeerKey(dir);
const closers = [];
after(() => {
  for (const c of closers) { try { c(); } catch { /* closed */ } }
  try { nodeDataChannel?.cleanup(); } catch { /* nothing to clean */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error(`timeout: ${what}`); await wait(20); }
};

function newPc() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  closers.push(() => pc.close());
  return pc;
}

/** A WebRTCPeerManager as the connector runs it, with a handle to the channel it opens. */
function connectorSide() {
  const mgr = new WebRTCPeerManager();
  closers.push(() => mgr.closeAll());
  const opened = [];
  mgr.on('datachannel', (dc, connectionId, dtls) => opened.push({ dc, connectionId, dtls }));
  return { mgr, opened };
}

/** Trickle ICE both ways between a peer connection and a connector manager. */
function wireIce(pc, mgr, connectionId) {
  pc.onicecandidate = (e) => { if (e.candidate) mgr.handleIceCandidate(connectionId, e.candidate.toJSON ? e.candidate.toJSON() : e.candidate); };
  mgr.on('ice-candidate-local', (d) => { if (d.connectionId === connectionId) pc.addIceCandidate(d.candidate).catch(() => {}); });
}

function config() {
  const { hashes } = generateBackupCodes();
  const cfg = {
    userId: 'u', serverUrl: 'wss://x/ws', apiKey: 'k', gatewayId: 'gw', schemaVersion: 2, installedAt: '2026-01-01T00:00:00Z',
    totp: { secret: generateTotpSecret(), algorithm: 'SHA1', digits: 6, period: 30, enabledAt: '2026-01-01T00:00:00Z' },
    sessionSecret: generateSessionSecret(), backupCodeHashes: hashes,
  };
  writeConfig(CONFIG, cfg);
  return cfg;
}

function loginHooks(log) {
  return {
    loadAuthConfig: () => readAuthConfig(CONFIG), consumeBackupCode: (h) => removeBackupCode(CONFIG, h),
    connectorKey: KEY, addDevice: (d, s) => addDevice(CONFIG, d, s), touchDevice: (id) => touchDevice(CONFIG, id),
    onAuthenticated: (i) => log.push(['authenticated', i.deviceId]), onMessage: (m) => log.push(['message', m.type]),
    onLoginFailure: (r) => log.push(['failure', r]), log: { info() {}, warn() {}, error() {} },
  };
}

/** The connector end of a real channel, behind the login gate, as src/index.ts sets it up. */
function gate({ opened }, log) {
  const { dc, connectionId, dtls } = opened.at(-1);
  attachBrowserChannel(dc, connectionId, loginHooks(log), dtls);
  return { connectionId, dtls };
}

test('browser and connector read the same two fingerprints; a device logs in over a real DataChannel', opts, async () => {
  const cfg = config();
  const browser = makeBrowser('Loopback browser');
  const now = new Date().toISOString();
  addDevice(CONFIG, { deviceId: browser.deviceId, pubkey: browser.pub, label: browser.label, createdAt: now, lastSeen: now }, cfg.totp.secret);
  _resetAuthForTests();

  const c = connectorSide();
  const pc = newPc();
  const connectionId = 'conn_loopback1';
  c.mgr.setIceServers({ connectionId, iceServers: [] });
  wireIce(pc, c.mgr, connectionId);
  const dc = pc.createDataChannel('clawchats', { ordered: true });
  const inbox = [];
  dc.onmessage = (e) => inbox.push(JSON.parse(e.data));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const answer = await c.mgr.handleOffer({ connectionId, sdp: offer.sdp, candidates: [] });
  await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  await until(() => c.opened.length === 1 && dc.readyState === 'open', 'channel open');

  // what the browser reads (its own offer, the connector's answer) is what the connector holds
  const browserView = { browser: sdpFingerprint(pc.localDescription.sdp), connector: sdpFingerprint(pc.remoteDescription.sdp) };
  assert.match(browserView.browser, /^[0-9A-F]{64}$/);
  assert.match(browserView.connector, /^[0-9A-F]{64}$/);
  assert.notEqual(browserView.browser, browserView.connector);
  assert.deepEqual(c.opened[0].dtls, browserView);

  const log = [];
  gate(c, log);
  await until(() => inbox.length === 1, 'auth-required');
  const authRequired = inbox[0];
  const binding = bindingOf(authRequired, connectionId, browserView);
  assert.ok(connectorProofOk(authRequired, binding), 'the browser accepts the connector proof computed from real SDPs');
  dc.send(JSON.stringify(deviceLogin(browser, binding)));
  await until(() => inbox.length === 2, 'auth-ok');
  assert.equal(inbox[1].type, 'auth-ok');
  dc.send(JSON.stringify({ type: 'rpc', id: '1' }));
  await until(() => log.some(l => l[0] === 'message'), 'message after login');
  assert.deepEqual(log, [['authenticated', browser.deviceId], ['message', 'rpc']]);
});

test('a relay with its own DTLS on each side cannot make a login work (MITM simulation)', opts, async () => {
  const cfg = config();
  const browser = makeBrowser('Victim');
  const now = new Date().toISOString();
  addDevice(CONFIG, { deviceId: browser.deviceId, pubkey: browser.pub, label: browser.label, createdAt: now, lastSeen: now }, cfg.totp.secret);
  _resetAuthForTests();

  // leg 1: browser (offerer) <-> M1 (answerer). leg 2: M2 (offerer) <-> connector (answerer)
  const c = connectorSide();
  const connectionId = 'conn_mitm1';
  c.mgr.setIceServers({ connectionId, iceServers: [] });
  const B = newPc(), M1 = newPc(), M2 = newPc();
  wireIce(M2, c.mgr, connectionId);
  B.onicecandidate = (e) => { if (e.candidate) M1.addIceCandidate(e.candidate).catch(() => {}); };
  M1.onicecandidate = (e) => { if (e.candidate) B.addIceCandidate(e.candidate).catch(() => {}); };

  const bDc = B.createDataChannel('clawchats', { ordered: true });
  const browserInbox = [];
  bDc.onmessage = (e) => browserInbox.push(JSON.parse(e.data));
  let m1Dc;
  M1.ondatachannel = (e) => { m1Dc = e.channel; };
  const m2Dc = M2.createDataChannel('clawchats', { ordered: true });

  // signaling relays SDP, and here it swaps in its own: the browser's offer goes to M1, M2's offer goes to the connector
  const offerB = await B.createOffer();
  await B.setLocalDescription(offerB);
  await M1.setRemoteDescription({ type: 'offer', sdp: offerB.sdp });
  const answerM1 = await M1.createAnswer();
  await M1.setLocalDescription(answerM1);
  await B.setRemoteDescription({ type: 'answer', sdp: answerM1.sdp });
  const offerM2 = await M2.createOffer();
  await M2.setLocalDescription(offerM2);
  const answerC = await c.mgr.handleOffer({ connectionId, sdp: offerM2.sdp, candidates: [] });
  await M2.setRemoteDescription({ type: 'answer', sdp: answerC.sdp });
  await until(() => c.opened.length === 1 && bDc.readyState === 'open' && m1Dc && m2Dc.readyState === 'open', 'both legs open');

  // the relay forwards everything between the two channels
  const connectorSees = [];
  m1Dc.onmessage = (e) => { connectorSees.push(['browser->connector', JSON.parse(e.data).type]); m2Dc.send(e.data); };
  m2Dc.onmessage = (e) => m1Dc.send(e.data);

  const log = [];
  gate(c, log);
  await until(() => browserInbox.length === 1, 'relayed auth-required');
  const authRequired = browserInbox[0];

  // four different views: no two sides agree on both fingerprints
  const fp = (pc, which) => sdpFingerprint(pc[which].sdp);
  const browserView = { browser: fp(B, 'localDescription'), connector: fp(B, 'remoteDescription') };
  const connectorView = c.opened[0].dtls;
  assert.notDeepEqual(browserView, connectorView);
  assert.equal(browserView.connector, fp(M1, 'localDescription'), 'the browser is talking to M1');
  assert.equal(connectorView.browser, fp(M2, 'localDescription'), 'the connector is talking to M2');

  // 1. an honest browser checks the connector's proof first and refuses: it never answers
  assert.equal(connectorProofOk(authRequired, bindingOf(authRequired, connectionId, browserView)), false);
  // 2. a careless browser that answers anyway: its login (signed over ITS view) does not verify at the connector
  bDc.send(JSON.stringify(deviceLogin(browser, bindingOf(authRequired, connectionId, browserView))));
  await until(() => browserInbox.length === 2, 'auth-failed');
  assert.deepEqual(browserInbox[1], { type: 'auth-failed', reason: 'invalid_signature' });
  assert.equal(log.filter(l => l[0] === 'authenticated').length, 0);
  // 3. the connector received exactly one message from the browser side and rejected it
  assert.deepEqual(connectorSees.map(m => m[1]), ['auth-device']);
});
