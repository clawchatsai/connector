// `openclaw clawchats devices [revoke]` and `show-fingerprint` (src/devices-cli.ts), on a real config.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDevices, revokeDevice, matchDevices, showFingerprint } from '../dist/devices-cli.js';
import { publicKeyWords } from '../dist/channel-binding.js';
import { addDevice, readConfig, updateConfig, writeConfig } from '../dist/config-store.js';
import { publicKeyFingerprint } from '../dist/channel-binding.js';
import { makeBrowser } from './helpers/browser.js';

function setup(labels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-devcli-'));
  const file = path.join(dir, 'config.json');
  writeConfig(file, { userId: 'u', serverUrl: 's', apiKey: 'k', schemaVersion: 2, installedAt: 'x', totp: { secret: 'S' } });
  const bs = labels.map(l => makeBrowser(l));
  for (const b of bs) addDevice(file, { deviceId: b.deviceId, pubkey: b.pub, label: b.label, createdAt: '2026-10-01T10:00:00.000Z', lastSeen: '2026-10-02T11:30:00.000Z' }, 'S');
  const lines = [];
  return { dir, file, bs, lines, out: (l) => lines.push(l) };
}

test('devices lists id, label and dates; empty and unconfigured say what to do', () => {
  const t = setup(['Chrome on Windows', 'Safari on iOS']);
  assert.equal(listDevices(t.file, t.out), true);
  const text = t.lines.join('\n');
  assert.match(text, /Paired browsers \(2\)/);
  for (const b of t.bs) assert.ok(text.includes(b.deviceId.slice(0, 8)) && text.includes(b.label));
  assert.match(text, /2026-10-01 10:00/);
  assert.match(text, /last login 2026-10-02 11:30/);
  assert.match(text, /devices revoke/);
  assert.ok(!text.includes(t.bs[0].pub), 'public keys are not printed');

  updateConfig(t.file, (c) => { c.devices = []; });
  t.lines.length = 0;
  listDevices(t.file, t.out);
  assert.match(t.lines.join('\n'), /No browsers are paired/);

  t.lines.length = 0;
  assert.equal(listDevices(path.join(t.dir, 'nope.json'), t.out), false);
  assert.match(t.lines.join('\n'), /not configured/);
});

test('devices revoke by id prefix, full id or label removes only that device', () => {
  const t = setup(['Chrome on Windows', 'Safari on iOS', 'Firefox on Linux']);
  assert.equal(revokeDevice(t.file, t.bs[0].deviceId.slice(0, 8), t.out), true);
  assert.match(t.lines.at(-1), /Revoked "Chrome on Windows"/);
  assert.equal(revokeDevice(t.file, 'safari on ios', t.out), true, 'label, any case');
  assert.equal(revokeDevice(t.file, t.bs[2].deviceId, t.out), true, 'full id');
  assert.deepEqual(readConfig(t.file).devices, []);
  assert.equal(readConfig(t.file).totp.secret, 'S', 'nothing else in the config changed');
});

test('devices revoke refuses unknown, short and ambiguous names and changes nothing', () => {
  const t = setup(['Laptop', 'Laptop', 'Phone']);
  const before = fs.readFileSync(t.file, 'utf8');
  assert.equal(revokeDevice(t.file, 'nobody', t.out), false);
  assert.match(t.lines.at(-1), /No paired browser matches/);
  assert.equal(revokeDevice(t.file, '', t.out), false);
  assert.equal(revokeDevice(t.file, t.bs[2].deviceId.slice(0, 3), t.out), false, 'too short to be an id prefix');
  t.lines.length = 0;
  assert.equal(revokeDevice(t.file, 'Laptop', t.out), false);
  assert.match(t.lines.join('\n'), /matches 2 browsers/);
  assert.equal(fs.readFileSync(t.file, 'utf8'), before);
  assert.equal(revokeDevice(t.file, t.bs[0].deviceId, t.out), true, 'by id it works');
  assert.deepEqual(readConfig(t.file).devices.map(d => d.label), ['Laptop', 'Phone']);
});

test('matchDevices: ids are matched exactly or by prefix of 6+, labels exactly', () => {
  const t = setup(['A', 'B']);
  const devices = readConfig(t.file).devices;
  assert.equal(matchDevices(devices, devices[0].deviceId).length, 1);
  assert.equal(matchDevices(devices, devices[0].deviceId.slice(0, 6)).length, 1);
  assert.equal(matchDevices(devices, devices[0].deviceId.slice(0, 5)).length, 0);
  assert.equal(matchDevices(devices, 'a').length, 1);
  assert.equal(matchDevices(devices, 'A ').length, 1);
  assert.equal(matchDevices(devices, 'AB').length, 0);
});

test('show-fingerprint prints the four words the browser shows, with the digits as a fallback', () => {
  const b = makeBrowser();
  const lines = [];
  assert.equal(showFingerprint(b.pub, (l) => lines.push(l)), true);
  assert.ok(lines.includes(`  ${publicKeyWords(b.pub)}`), 'the words, on their own line');
  assert.ok(lines.some(l => l.includes(publicKeyFingerprint(b.pub))), 'the digits too');
  assert.match(publicKeyWords(b.pub), /^[a-z]+(-[a-z]+){3}$/);
  assert.match(publicKeyFingerprint(b.pub), /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
  assert.equal(showFingerprint(null, (l) => lines.push(l)), false);
});
