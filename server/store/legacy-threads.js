// `ocplatform clawchats import-dates`: one-off migration from the pre-gateway ClawChats databases
// (one <project>.db per project in the data dir, each with a `threads` table). The gateway has no
// creation time for sessions created before it recorded `createdAt`, and `sessions.patch` can't
// set one, so the connector keeps them (ExtrasStore `legacy_created`). Safe to re-run. Once every
// install has run it, this file and the command can go; the stored dates stay.

import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../bootstrap/native.js';
import { createExtrasStore } from './extras-store.js';

/** `read(db)` over every legacy project DB in `dataDir` that has a threads table; unreadable files are skipped. */
function eachLegacyDb(dataDir, logger, read) {
  let files = [];
  try { files = fs.readdirSync(dataDir).filter(f => f.endsWith('.db') && f !== 'global.db' && f !== 'search.db'); } catch { return; }
  for (const f of files) {
    let db;
    try {
      db = new Database(path.join(dataDir, f), { readOnly: true });
      const hasThreads = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
      if (hasThreads) read(db);
    } catch (e) {
      logger.warn?.(`[legacy] skipped ${f}: ${e.message}`);
    } finally {
      db?.close();
    }
  }
}

/** [{ sessionKey, createdAt }] from every legacy project DB in `dataDir`. */
export function readLegacyThreadDates(dataDir, logger = console) {
  const out = [];
  eachLegacyDb(dataDir, logger, db => {
    for (const r of db.prepare('SELECT session_key, created_at FROM threads WHERE session_key IS NOT NULL AND created_at > 0').all()) {
      out.push({ sessionKey: r.session_key, createdAt: Number(r.created_at) });
    }
  });
  return out;
}

/**
 * The old Smart-search summaries ([{ key, summary, keywords, messages, taggedAt }]): the old app wrote
 * `metadata = { summary, topics, entities, … }` per thread. Topics were free phrases, not shared tags,
 * so they become keywords (searchable) and the chat is tagged like any other later.
 */
export function readLegacyThreadSummaries(dataDir, logger = console) {
  const out = [];
  eachLegacyDb(dataDir, logger, db => {
    if (!db.prepare('PRAGMA table_info(threads)').all().some(c => c.name === 'metadata')) return;
    for (const r of db.prepare("SELECT session_key, metadata FROM threads WHERE session_key IS NOT NULL AND metadata LIKE '%summary%'").all()) {
      let m;
      try { m = JSON.parse(r.metadata); } catch { continue; }
      const summary = typeof m?.summary === 'string' ? m.summary.trim() : '';
      if (!summary) continue;
      const words = [...(Array.isArray(m.topics) ? m.topics : []), ...(Array.isArray(m.entities) ? m.entities : [])].filter(w => typeof w === 'string' && w.trim());
      out.push({ key: r.session_key, summary: summary.slice(0, 200), keywords: [...new Set(words.map(w => w.trim().slice(0, 60)))].slice(0, 10), messages: 0, taggedAt: Number(m.generatedAt) || null });
    }
  });
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
