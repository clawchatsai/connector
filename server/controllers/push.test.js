import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { createPushHandlers } from './push.js';
import { createPush } from '../push/index.js';

function fakeRes() {
  const r = { status: 0, body: null, writeHead(s) { r.status = s; }, end(b) { r.body = JSON.parse(b); } };
  return r;
}
const fakeReq = body => Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: {} });
const keys = () => {
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  return { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
};

function setup(devFile) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-routes-'));
  if (devFile) fs.writeFileSync(path.join(dataDir, 'push-dev.json'), JSON.stringify(devFile));
  const push = createPush({ dataDir, lens: { isTopLevel: () => true }, request: async () => ({}), gatewayId: () => 'gw', log: { warn() {}, info() {} } });
  const handle = createPushHandlers(push);
  const call = async (method, url, body) => { const res = fakeRes(); const hit = await handle(fakeReq(body), res, method, url); return hit ? res : null; };
  return { push, call, dataDir };
}

test('subscribe, list, set prefs, unsubscribe, remove', async () => {
  const { call } = setup();
  assert.deepEqual((await call('GET', '/api/push')).body, { enabled: true, publicKey: null, devices: [] });
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: keys() };
  const r = await call('POST', '/api/push/subscribe', { subscription: sub, deviceLabel: 'Chrome on Android', mobile: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.device.prefs.replies, false);
  assert.equal(r.body.device.endpoint, undefined);
  const again = await call('POST', '/api/push/subscribe', { subscription: sub, deviceLabel: 'Chrome on Android', mobile: true });
  assert.equal(again.body.device.id, r.body.device.id); // idempotent
  const id = r.body.device.id;
  assert.equal((await call('PUT', `/api/push/devices/${id}`, { prefs: { replies: true, bogus: 1, showPreviews: 'no' } })).body.device.prefs.replies, true);
  assert.equal((await call('GET', '/api/push')).body.devices[0].prefs.showPreviews, true);
  assert.equal((await call('PUT', '/api/push/devices/nope', { prefs: {} })).status, 404);
  assert.equal((await call('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint })).body.removed, true);
  assert.equal((await call('GET', '/api/push')).body.devices.length, 0);
  await call('POST', '/api/push/subscribe', { subscription: sub });
  assert.equal((await call('DELETE', `/api/push/devices/${id}`)).body.removed, true);
  assert.equal(await call('GET', '/api/settings'), null); // not ours
});

test('refuses endpoints that are not push services, and missing keys', async () => {
  const { call } = setup();
  for (const endpoint of ['https://attacker.example/collect', 'http://fcm.googleapis.com/x', 'https://169.254.169.254/latest']) {
    assert.equal((await call('POST', '/api/push/subscribe', { subscription: { endpoint, keys: keys() } })).status, 400, endpoint);
  }
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: {} } })).status, 400);
});

test('push-dev.json: a local VAPID key is offered to browsers and the escalation threshold is configurable', async () => {
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  const { call, push } = setup({ vapidPrivateKey: e.getPrivateKey().toString('base64url'), approvalEscalateMs: 15000 });
  assert.equal((await call('GET', '/api/push')).body.publicKey, e.getPublicKey().toString('base64url'));
  assert.equal(push.notifier.escalateMs, 15000);
});

test('POST /api/push/devices/:id/test sends one test push; unknown device 404', async () => {
  const { call, push } = setup();
  const r = await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/t', keys: keys() }, deviceLabel: 'Chrome on Linux' });
  const id = r.body.device.id;
  const sent = [];
  push.notifier.sendTest = async x => { sent.push(x); return true; };
  assert.equal((await call('POST', `/api/push/devices/${id}/test`)).status, 200);
  assert.deepEqual(sent, [id]);
  assert.equal((await call('POST', '/api/push/devices/nope/test')).status, 404);
  push.notifier.sendTest = async () => false;
  assert.equal((await call('POST', `/api/push/devices/${id}/test`)).status, 502);
});
