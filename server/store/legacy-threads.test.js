import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../bootstrap/native.js';
import { readLegacyThreadDates, importLegacyThreadDates } from './legacy-threads.js';
import { createExtrasStore } from './extras-store.js';

function legacyDb(file, rows) {
  const db = new Database(file);
  db.exec('CREATE TABLE threads (id TEXT, session_key TEXT, created_at INTEGER)');
  const ins = db.prepare('INSERT INTO threads VALUES (?, ?, ?)');
  for (const r of rows) ins.run(...r);
  db.close();
}

test('reads creation times from every legacy project DB; skips global.db, non-thread DBs and junk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-legacy-'));
  try {
    legacyDb(path.join(dir, 'default.db'), [['a', 'agent:main:default:chat:a', 100], ['b', null, 200], ['c', 'agent:main:default:chat:c', 0]]);
    legacyDb(path.join(dir, 'proxmox.db'), [['p', 'agent:main:proxmox:chat:p', 300]]);
    legacyDb(path.join(dir, 'global.db'), [['g', 'agent:main:x:chat:g', 400]]);
    new Database(path.join(dir, 'alerts.db')).close(); // no threads table
    fs.writeFileSync(path.join(dir, 'broken.db'), 'not sqlite');
    const rows = readLegacyThreadDates(dir, { warn() {} }).sort((x, y) => x.createdAt - y.createdAt);
    assert.deepEqual(rows, [{ sessionKey: 'agent:main:default:chat:a', createdAt: 100 }, { sessionKey: 'agent:main:proxmox:chat:p', createdAt: 300 }]);
    assert.deepEqual(readLegacyThreadDates(path.join(dir, 'missing')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seeding is insert-or-ignore and readable as a map', () => {
  const g = new Database(':memory:');
  const extras = createExtrasStore(() => g);
  assert.equal(extras.seedLegacyCreatedAt([{ sessionKey: 'k1', createdAt: 5 }, { sessionKey: 'k2', createdAt: 6 }, { sessionKey: '', createdAt: 7 }]), 2);
  assert.equal(extras.seedLegacyCreatedAt([{ sessionKey: 'k1', createdAt: 99 }]), 0);
  assert.deepEqual([...extras.getLegacyCreatedAt()], [['k1', 5], ['k2', 6]]);
});

test('import-dates: writes into global.db, re-running imports nothing new', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-legacy-'));
  try {
    legacyDb(path.join(dir, 'default.db'), [['a', 'agent:main:default:chat:a', 100]]);
    assert.deepEqual(importLegacyThreadDates(dir), { found: 1, imported: 1 });
    assert.deepEqual(importLegacyThreadDates(dir), { found: 1, imported: 0 });
    const g = new Database(path.join(dir, 'global.db'));
    assert.deepEqual([...createExtrasStore(() => g).getLegacyCreatedAt()], [['agent:main:default:chat:a', 100]]);
    g.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
