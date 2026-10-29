// config.json I/O (src/config-store.ts): atomic writes, read-modify-write, strict login settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic, updateConfig, readAuthConfig, removeBackupCode, authEpoch } from '../dist/config-store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cfg-'));

test('atomic write: owner-only, no temp files left, replaces a world-readable file', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, 'old', { mode: 0o644 });
  writeFileAtomic(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  fs.rmSync(dir, { recursive: true });
});

test('updateConfig re-reads from disk and does not resurrect a deleted config', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  assert.equal(updateConfig(file, (c) => { c.gatewayId = 'x'; }), null);
  assert.ok(!fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify({ userId: 'u', apiKey: 'k', serverUrl: 's', gatewayId: 'a' }));
  const before = fs.statSync(file).mtimeMs;
  updateConfig(file, () => false); // nothing to change: no write
  assert.equal(fs.statSync(file).mtimeMs, before);
  updateConfig(file, (c) => { c.gatewayId = 'b'; });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).gatewayId, 'b');
  assert.equal(removeBackupCode(file, 'nope'), false);
  fs.rmSync(dir, { recursive: true });
});

test('updateConfig never overwrites a change another process made while it was writing', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  const base = { userId: 'u', apiKey: 'k', serverUrl: 's', totp: { secret: 'OLD' } };
  fs.writeFileSync(file, JSON.stringify(base));
  let calls = 0;
  updateConfig(file, (c) => {
    if (++calls === 1) fs.writeFileSync(file, JSON.stringify({ ...base, totp: { secret: 'NEW (reauth)' } })); // lands mid-update
    c.backupCodeHashes = ['h'];
  });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(calls, 2, 'started over from the new version');
  assert.equal(disk.totp.secret, 'NEW (reauth)');
  assert.deepEqual(disk.backupCodeHashes, ['h']);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  fs.rmSync(dir, { recursive: true });
});

test('readAuthConfig: missing vs damaged vs needs 2FA; epoch follows the secrets', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  assert.deepEqual(readAuthConfig(file), { ok: false, reason: 'missing' });
  fs.writeFileSync(file, '{"userId":"u","apiKey"');
  assert.deepEqual(readAuthConfig(file), { ok: false, reason: 'invalid' });
  const base = { userId: 'u', apiKey: 'k', serverUrl: 's', schemaVersion: 1 };
  fs.writeFileSync(file, JSON.stringify(base));
  assert.deepEqual(readAuthConfig(file), { ok: false, reason: 'needs-2fa' });
  const v2 = { ...base, schemaVersion: 2, totp: { secret: 'JBSWY3DPEHPK3PXP' }, sessionSecret: 'ab'.repeat(32) };
  fs.writeFileSync(file, JSON.stringify(v2));
  const r = readAuthConfig(file);
  assert.equal(r.ok, true);
  assert.equal(r.config.google.clientId, 'dev-placeholder');
  fs.writeFileSync(file, JSON.stringify({ ...v2, google: { clientId: 1 } }));
  assert.deepEqual(readAuthConfig(file), { ok: false, reason: 'invalid' });
  fs.writeFileSync(file, JSON.stringify({ ...v2, schemaVersion: 3 }));
  assert.deepEqual(readAuthConfig(file), { ok: false, reason: 'invalid' });

  const e1 = authEpoch(r.config);
  assert.equal(authEpoch({ ...r.config, backupCodeHashes: [] }), e1);
  assert.notEqual(authEpoch({ ...r.config, sessionSecret: 'cd'.repeat(32) }), e1);
  assert.notEqual(authEpoch({ ...r.config, totp: { ...r.config.totp, secret: 'X' } }), e1);
  fs.rmSync(dir, { recursive: true });
});
