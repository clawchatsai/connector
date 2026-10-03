// `ocplatform clawchats import-dates`: one-off migration from the pre-gateway ClawChats databases
// (one <project>.db per project in the data dir, each with a `threads` table). The gateway has no
// creation time for sessions created before it recorded `createdAt`, and `sessions.patch` can't
// set one, so the connector keeps them (ExtrasStore `legacy_created`). Safe to re-run. Once every
// install has run it, this file and the command can go; the stored dates stay.

import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../bootstrap/native.js';
import { createExtrasStore } from './extras-store.js';

/** [{ sessionKey, createdAt }] from every legacy project DB in `dataDir`; unreadable files are skipped. */
export function readLegacyThreadDates(dataDir, logger = console) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dataDir).filter(f => f.endsWith('.db') && f !== 'global.db'); } catch { return out; }
  for (const f of files) {
    let db;
    try {
      db = new Database(path.join(dataDir, f), { readOnly: true });
      const hasThreads = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
      if (!hasThreads) continue;
      for (const r of db.prepare('SELECT session_key, created_at FROM threads WHERE session_key IS NOT NULL AND created_at > 0').all()) {
        out.push({ sessionKey: r.session_key, createdAt: Number(r.created_at) });
      }
    } catch (e) {
      logger.warn?.(`[legacy] skipped ${f}: ${e.message}`);
    } finally {
      db?.close();
    }
  }
  return out;
}

/** Copy legacy creation times into global.db. Returns { found, imported } (imported = new rows). */
export function importLegacyThreadDates(dataDir, logger = console) {
  const rows = readLegacyThreadDates(dataDir, logger);
  const db = new Database(path.join(dataDir, 'global.db'));
  try {
    return { found: rows.length, imported: createExtrasStore(() => db).seedLegacyCreatedAt(rows) };
  } finally { db.close(); }
}
