// SearchStore: the connector's full-text index of ClawChats chats (data/search.db, node:sqlite FTS5).
//
// Derived data only. The gateway's transcripts are the source of truth; this file can be deleted at
// any time and the indexer (indexer.js) rebuilds it. A schema/tokenizer change bumps SCHEMA, which
// drops and rebuilds the index instead of migrating it.
//
//   chats          one row per indexed chat: gateway stamps (sessionId, change time, delta cursor),
//                  title/archived for matching and filtering, sync bookkeeping and the last error
//   docs           searchable documents: message text (kind 'message') and selection comments
//                  (kind 'comment', ord = attachment position), keyed to the gateway entry id
//   docs_fts       FTS5 over docs (text, quote), porter stemming + prefix index: "deplo" finds deploy
//   chats_fts      FTS5 over chat titles
//   comment_files  selection-comment bodies by media URL (immutable files: fetched once)
//   chat_meta      a chat's tags, summary and keywords, copied from the tag store (server/tags/) so
//                  search matches them; meta_fts over them. Dropped with the chat; the tagger refills it.

import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../bootstrap/native.js';
import { normalizeTag } from '../tags/model.js';

const SCHEMA = 2;
const TOKENIZE = "tokenize = 'porter unicode61 remove_diacritics 2', prefix = '2 3'";
const MAX_QUERY_CHARS = 500;
const MAX_QUERY_TERMS = 16;
const HIT_SAMPLE = 5000; // best-ranked hits read per query, to pick each chat's top snippets
export const SNIPPET_OPEN = '\u0002';
export const SNIPPET_CLOSE = '\u0003';
const MISSING_FILE_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * User input → FTS5 query. Every word must appear (AND), each as a prefix so results follow typing;
 * "double quotes" make an exact phrase. Words are passed as FTS strings, so operators and
 * punctuation in the input are plain text. Returns null when nothing searchable is left.
 */
export function toFtsQuery(input) {
  const s = String(input || '').slice(0, MAX_QUERY_CHARS);
  const terms = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s)) && terms.length < MAX_QUERY_TERMS) {
    const phrase = m[1] !== undefined;
    const raw = (phrase ? m[1] : m[2]).trim();
    // A term FTS5 would tokenize to nothing (only punctuation) can't match: drop it.
    if (!raw || !/[\p{L}\p{N}]/u.test(raw)) continue;
    const quoted = `"${raw.replace(/"/g, '""')}"`;
    terms.push(phrase ? quoted : `${quoted}*`);
  }
  return terms.length ? terms.join(' AND ') : null;
}

/**
 * `#tag` words of a query (a filter: only chats carrying every one) and the rest (searched as text).
 * "#laser-show deploy" = chats tagged laser-show that mention deploy; "#laser-show" alone lists them.
 */
export function parseQuery(input) {
  const tags = [];
  const text = String(input || '').slice(0, MAX_QUERY_CHARS).replace(/(^|\s)#([^\s#"]+)/g, (all, pre, raw) => {
    const t = normalizeTag(raw);
    if (t && !tags.includes(t)) tags.push(t);
    return pre;
  }).trim();
  return { text, tags };
}

// bm25 is negative, lower = better. A title, tag or summary match and many hits lift a chat; recency breaks ties.
const BOOST = { title: 4, tag: 3, about: 2 };

function rankChats(groups, matched) {
  for (const g of groups) {
    g.score = g.best - Math.log1p(g.hits) * 0.5;
    for (const [kind, keys] of Object.entries(matched)) if (keys.has(g.key)) g.score -= BOOST[kind];
  }
  return groups.sort((a, b) => a.score - b.score || (b.lastTs || 0) - (a.lastTs || 0));
}

const parseList = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

export class SearchStore {
  /** @param {string|null} file  database path; null = in memory (tests) */
  constructor(file) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file || ':memory:');
    if (file) { try { fs.chmodSync(file, 0o600); } catch { /* best effort: copies of transcripts */ } }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000');
    this._open();
  }

  _open() {
    const v = this._meta('schema');
    if (v !== null && Number(v) !== SCHEMA) this._dropAll();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS chats (
        key TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT, title TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0, stamp INTEGER NOT NULL DEFAULT 0, synced_stamp INTEGER NOT NULL DEFAULT -1,
        cursor TEXT, total INTEGER, last_id TEXT, synced_at INTEGER, full_at INTEGER, docs INTEGER NOT NULL DEFAULT 0,
        error TEXT, error_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY, key TEXT NOT NULL REFERENCES chats(key) ON DELETE CASCADE,
        message_id TEXT NOT NULL, kind TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL, ts INTEGER, text TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '',
        UNIQUE (key, message_id, kind, ord));
      CREATE INDEX IF NOT EXISTS docs_key ON docs(key);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(text, quote, content = 'docs', content_rowid = 'id', ${TOKENIZE});
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, text, quote) VALUES (new.id, new.text, new.quote); END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, text, quote) VALUES ('delete', old.id, old.text, old.quote); END;
      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE OF text, quote ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, text, quote) VALUES ('delete', old.id, old.text, old.quote);
        INSERT INTO docs_fts(rowid, text, quote) VALUES (new.id, new.text, new.quote); END;
      CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(title, content = 'chats', content_rowid = 'rowid', ${TOKENIZE});
      CREATE TRIGGER IF NOT EXISTS chats_ai AFTER INSERT ON chats BEGIN
        INSERT INTO chats_fts(rowid, title) VALUES (new.rowid, new.title); END;
      CREATE TRIGGER IF NOT EXISTS chats_ad AFTER DELETE ON chats BEGIN
        INSERT INTO chats_fts(chats_fts, rowid, title) VALUES ('delete', old.rowid, old.title); END;
      CREATE TRIGGER IF NOT EXISTS chats_au AFTER UPDATE OF title ON chats BEGIN
        INSERT INTO chats_fts(chats_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
        INSERT INTO chats_fts(rowid, title) VALUES (new.rowid, new.title); END;
      CREATE TABLE IF NOT EXISTS comment_files (url TEXT PRIMARY KEY, body TEXT, status TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_meta (
        key TEXT PRIMARY KEY REFERENCES chats(key) ON DELETE CASCADE, tag_list TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '');
      CREATE VIRTUAL TABLE IF NOT EXISTS meta_fts USING fts5(tags, summary, keywords, content = 'chat_meta', content_rowid = 'rowid', ${TOKENIZE});
      CREATE TRIGGER IF NOT EXISTS meta_ai AFTER INSERT ON chat_meta BEGIN
        INSERT INTO meta_fts(rowid, tags, summary, keywords) VALUES (new.rowid, new.tags, new.summary, new.keywords); END;
      CREATE TRIGGER IF NOT EXISTS meta_ad AFTER DELETE ON chat_meta BEGIN
        INSERT INTO meta_fts(meta_fts, rowid, tags, summary, keywords) VALUES ('delete', old.rowid, old.tags, old.summary, old.keywords); END;
      CREATE TRIGGER IF NOT EXISTS meta_au AFTER UPDATE ON chat_meta BEGIN
        INSERT INTO meta_fts(meta_fts, rowid, tags, summary, keywords) VALUES ('delete', old.rowid, old.tags, old.summary, old.keywords);
        INSERT INTO meta_fts(rowid, tags, summary, keywords) VALUES (new.rowid, new.tags, new.summary, new.keywords); END;
    `);
    this._setMeta('schema', String(SCHEMA));
  }

  _dropAll() {
    this.db.exec(`
      DROP TABLE IF EXISTS meta_fts; DROP TABLE IF EXISTS chat_meta;
      DROP TABLE IF EXISTS docs_fts; DROP TABLE IF EXISTS chats_fts; DROP TABLE IF EXISTS docs;
      DROP TABLE IF EXISTS chats; DROP TABLE IF EXISTS comment_files; DROP TABLE IF EXISTS meta;`);
  }

  _meta(k) {
    try { return this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null; } catch { return null; }
  }

  _setMeta(k, v) {
    if (v === null) this.db.prepare('DELETE FROM meta WHERE k = ?').run(k);
    else this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  close() { try { this.db.close(); } catch { /* closed */ } }

  /** Throw everything away (Rebuild). The indexer refills it. */
  reset() {
    this._tx(() => { this.db.exec('DELETE FROM docs; DELETE FROM chats; DELETE FROM comment_files; DELETE FROM meta'); this._setMeta('schema', String(SCHEMA)); });
  }

  /**
   * The indexer's extraction rules changed (a connector update fixed or widened what gets indexed):
   * every chat is re-read whole on the next pass. Documents stay searchable meanwhile.
   */
  requireIndexerVersion(version) {
    if (this._meta('indexer') === String(version)) return false;
    this._tx(() => {
      this.db.exec('UPDATE chats SET synced_stamp = -1, cursor = NULL, total = NULL, last_id = NULL');
      this._setMeta('indexer', String(version));
    });
    return true;
  }

  /** When the index last finished a pass over every chat (null until the first backfill is done). */
  get completedAt() { const v = this._meta('completed_at'); return v ? Number(v) : null; }
  set completedAt(ts) { this._setMeta('completed_at', ts ? String(ts) : null); }

  // ── Chats ─────────────────────────────────────────────────────────

  getChat(key) { return this.db.prepare('SELECT * FROM chats WHERE key = ?').get(key) || null; }

  chatKeys() { return this.db.prepare('SELECT key FROM chats').all().map(r => r.key); }

  /** Title, archive state, agent and change stamp from a gateway row; creates the chat if new. */
  upsertChat({ key, agentId = null, title = '', archived = false, stamp = 0 }) {
    this.db.prepare(`INSERT INTO chats (key, agent_id, title, archived, stamp) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET agent_id = excluded.agent_id, title = excluded.title, archived = excluded.archived,
        stamp = MAX(chats.stamp, excluded.stamp)`).run(key, agentId, title, archived ? 1 : 0, stamp);
  }

  deleteChat(key) { return this.db.prepare('DELETE FROM chats WHERE key = ?').run(key).changes > 0; }

  /** Chats whose transcript changed since they were last indexed (or that failed), oldest change first. */
  staleKeys() {
    return this.db.prepare('SELECT key FROM chats WHERE synced_stamp < stamp OR error IS NOT NULL ORDER BY stamp').all().map(r => r.key);
  }

  /** Chats due a full re-read (self-check against drift), least recently verified first. */
  dueForFullRead(olderThan, limit) {
    return this.db.prepare('SELECT key FROM chats WHERE full_at IS NULL OR full_at < ? ORDER BY COALESCE(full_at, 0) LIMIT ?').all(olderThan, limit).map(r => r.key);
  }

  markFailed(key, message, now) {
    this.db.prepare('UPDATE chats SET error = ?, error_at = ?, attempts = attempts + 1 WHERE key = ?').run(String(message).slice(0, 500), now, key);
  }

  // ── Documents ─────────────────────────────────────────────────────

  /**
   * Store a chat's documents after a sync. `full` replaces the chat's whole set (rows no longer in the
   * gateway's history go); otherwise `docs` are upserted (delta: appended entries only). Stamps the
   * chat as synced up to `stamp` in the same transaction, so a crash never leaves it marked current.
   */
  writeDocs(key, docs, { full, sessionId, cursor, total = null, lastId = null, stamp, now }) {
    return this._tx(() => {
      if (full) this.db.prepare('DELETE FROM docs WHERE key = ?').run(key);
      const put = this.db.prepare(`INSERT INTO docs (key, message_id, kind, ord, role, ts, text, quote) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key, message_id, kind, ord) DO UPDATE SET role = excluded.role, ts = excluded.ts, text = excluded.text, quote = excluded.quote
        WHERE docs.text IS NOT excluded.text OR docs.quote IS NOT excluded.quote OR docs.role IS NOT excluded.role OR docs.ts IS NOT excluded.ts`);
      for (const d of docs) put.run(key, d.messageId, d.kind, d.ord || 0, d.role, d.ts ?? null, d.text, d.quote || '');
      const count = this.db.prepare('SELECT COUNT(*) n FROM docs WHERE key = ?').get(key).n;
      this.db.prepare(`UPDATE chats SET session_id = ?, cursor = ?, total = ?, last_id = ?, synced_stamp = MAX(synced_stamp, ?), synced_at = ?,
        full_at = CASE WHEN ? THEN ? ELSE full_at END, docs = ?, error = NULL, error_at = NULL, attempts = 0 WHERE key = ?`)
        .run(sessionId ?? null, cursor ?? null, total, lastId, stamp, now, full ? 1 : 0, now, count, key);
      return count;
    });
  }

  /** The chat was checked and nothing changed: current up to `stamp`. */
  markSynced(key, stamp, now) {
    this.db.prepare('UPDATE chats SET synced_stamp = MAX(synced_stamp, ?), synced_at = ?, error = NULL, error_at = NULL, attempts = 0 WHERE key = ?').run(stamp, now, key);
  }

  // ── Comment files ─────────────────────────────────────────────────

  /** A cached comment body: { body } when fetched, { missing: true } inside the retry window, else null. */
  commentFile(url, now) {
    const r = this.db.prepare('SELECT body, status, fetched_at FROM comment_files WHERE url = ?').get(url);
    if (!r) return null;
    if (r.status === 'ok') return { body: r.body };
    return now - r.fetched_at < MISSING_FILE_RETRY_MS ? { missing: true } : null;
  }

  putCommentFile(url, body, now) {
    this.db.prepare(`INSERT INTO comment_files (url, body, status, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET body = excluded.body, status = excluded.status, fetched_at = excluded.fetched_at`)
      .run(url, body ?? null, body == null ? 'missing' : 'ok', now);
  }

  // ── Tags and summaries (copied from the tag store) ─────────────────

  /** A chat's tags, summary and keywords; nothing happens for a chat the index doesn't have (yet). */
  setMeta(key, { tags = [], summary = '', keywords = [] }) {
    if (!this.getChat(key)) return false;
    this.db.prepare(`INSERT INTO chat_meta (key, tag_list, tags, summary, keywords) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET tag_list = excluded.tag_list, tags = excluded.tags, summary = excluded.summary, keywords = excluded.keywords
      WHERE chat_meta.tag_list IS NOT excluded.tag_list OR chat_meta.summary IS NOT excluded.summary OR chat_meta.keywords IS NOT excluded.keywords`)
      .run(key, JSON.stringify(tags), tags.join(' '), summary, keywords.join(' · '));
    return true;
  }

  hasMeta(key) { return !!this.db.prepare('SELECT 1 FROM chat_meta WHERE key = ?').get(key); }

  /** A chat's messages and comments, oldest first (what the tagger reads), and their count. */
  messages(key) {
    return this.db.prepare('SELECT role, kind, text, quote, ts FROM docs WHERE key = ? ORDER BY ts, id').all(key);
  }

  messageCount(key) { return this.db.prepare("SELECT COUNT(*) n FROM docs WHERE key = ? AND kind = 'message'").get(key).n; }

  /** Chats with at least `minMessages` messages: key, title, change stamp, message count, text size. */
  taggable(minMessages) {
    return this.db.prepare(`SELECT c.key, c.title, c.stamp, COUNT(*) messages, SUM(LENGTH(d.text)) chars FROM chats c
      JOIN docs d ON d.key = c.key AND d.kind = 'message' GROUP BY c.key HAVING COUNT(*) >= ?`).all(minMessages);
  }

  // ── Query ─────────────────────────────────────────────────────────

  /**
   * One row per chat, best first: { key, title, archived, hits, titleMatch, tagMatch, summaryMatch, lastTs,
   * tags, summary, snippets: [{ messageId, kind, role, ts, snippet }] }. Snippet matches are wrapped in
   * SNIPPET_OPEN/SNIPPET_CLOSE. `#tag` words in `q` filter (parseQuery; a tag starting with it counts);
   * a query of only tags lists those chats, latest first.
   * @param {object} o
   * @param {string} o.q
   * @param {'user'|'assistant'|null} [o.role]  only documents by this author ('chat': another chat or an automation) (title, tag and summary matches still count)
   * @param {boolean} [o.archived=true]  include archived chats
   * @param {number} [o.limit=50]  chats
   * @param {number} [o.perChat=3]  snippets per chat
   */
  search({ q, role = null, archived = true, limit = 50, perChat = 3 }) {
    const { text, tags } = parseQuery(q);
    const match = toFtsQuery(text);
    if (!match && !tags.length) return { results: [], truncated: false };
    const arch = archived ? '' : 'AND c.archived = 0';
    const only = tags.length ? new Set(this._keysTagged(tags, arch)) : null;
    const allowed = key => !only || only.has(key);
    const matched = { title: new Set(), tag: new Set(), about: new Set() };
    const groups = new Map();
    const group = key => groups.get(key) || groups.set(key, { key, hits: 0, best: 0, lastTs: null, snippets: [] }).get(key);
    const roleSql = role ? 'AND d.role = ?' : '';
    const args = role ? [match, role] : [match];
    if (!match) for (const key of only) group(key);
    else {
      if (!role) {
        const keys = (sql, m) => this.db.prepare(sql).all(m).map(r => r.key).filter(allowed);
        matched.title = new Set(keys(`SELECT c.key FROM chats_fts JOIN chats c ON c.rowid = chats_fts.rowid WHERE chats_fts MATCH ? ${arch}`, match));
        const meta = `SELECT c.key FROM meta_fts JOIN chat_meta m ON m.rowid = meta_fts.rowid JOIN chats c ON c.key = m.key WHERE meta_fts MATCH ? ${arch}`;
        matched.tag = new Set(keys(meta, `{tags} : (${match})`));
        matched.about = new Set(keys(meta, `{summary keywords} : (${match})`));
      }
      // bm25() can't sit inside an aggregate: rank in a materialized CTE, then group.
      const counts = this.db.prepare(`WITH h AS MATERIALIZED (SELECT d.key, d.ts, bm25(docs_fts, 1.0, 0.6) score
          FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid JOIN chats c ON c.key = d.key
          WHERE docs_fts MATCH ? ${roleSql} ${arch})
        SELECT key, COUNT(*) n, MIN(score) best, MAX(ts) last_ts FROM h GROUP BY key`).all(...args);
      for (const r of counts) if (allowed(r.key)) Object.assign(group(r.key), { hits: r.n, best: r.best, lastTs: r.last_ts });
      for (const keys of Object.values(matched)) for (const key of keys) group(key);
    }
    const info = this.db.prepare('SELECT c.title, c.archived, c.stamp, m.tag_list, m.summary FROM chats c LEFT JOIN chat_meta m ON m.key = c.key WHERE c.key = ?');
    for (const g of groups.values()) { g.info = info.get(g.key); g.lastTs ??= g.info?.stamp || null; }
    const ranked = match ? rankChats([...groups.values()], matched) : [...groups.values()].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    const page = ranked.slice(0, limit);
    if (match) {
      const wanted = new Set(page.map(g => g.key));
      const hits = this.db.prepare(`SELECT d.key, d.message_id, d.kind, d.role, d.ts,
          snippet(docs_fts, -1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 24) snip
        FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid JOIN chats c ON c.key = d.key
        WHERE docs_fts MATCH ? ${roleSql} ${arch} ORDER BY bm25(docs_fts, 1.0, 0.6) LIMIT ${HIT_SAMPLE}`).all(...args);
      for (const h of hits) {
        const g = wanted.has(h.key) && groups.get(h.key);
        if (g && g.snippets.length < perChat) g.snippets.push({ messageId: h.message_id, kind: h.kind, role: h.role, ts: h.ts, snippet: h.snip });
      }
    }
    const results = page.map(g => ({
      key: g.key, title: g.info?.title || '', archived: !!g.info?.archived, hits: g.hits,
      titleMatch: matched.title.has(g.key), tagMatch: matched.tag.has(g.key), summaryMatch: matched.about.has(g.key),
      lastTs: g.lastTs, tags: parseList(g.info?.tag_list), summary: g.info?.summary || '', snippets: g.snippets,
    }));
    return { results, truncated: ranked.length > limit };
  }

  /** Chats carrying, for each of `tags`, a tag that starts with it (results follow typing, like words do). */
  _keysTagged(tags, arch) {
    const each = tags.map(() => "EXISTS (SELECT 1 FROM json_each(m.tag_list) WHERE value LIKE ? ESCAPE '\\')").join(' AND ');
    const prefixes = tags.map(t => `${t.replace(/[\\%_]/g, c => `\\${c}`)}%`);
    return this.db.prepare(`SELECT m.key FROM chat_meta m JOIN chats c ON c.key = m.key WHERE ${each} ${arch}`).all(...prefixes).map(r => r.key);
  }

  /** Coverage numbers for the status line and the Settings check. */
  stats() {
    const c = this.db.prepare(`SELECT COUNT(*) chats, SUM(synced_stamp >= stamp AND error IS NULL) current,
      SUM(error IS NOT NULL) failed, SUM(synced_at IS NULL) never FROM chats`).get();
    const d = this.db.prepare("SELECT COUNT(*) docs, SUM(kind = 'comment') comments FROM docs").get();
    return { chats: c.chats || 0, current: c.current || 0, failed: c.failed || 0, neverIndexed: c.never || 0, docs: d.docs || 0, comments: d.comments || 0 };
  }

  /** Per-chat coverage rows (Settings): key, docs, last sync, error. */
  coverage() {
    return this.db.prepare('SELECT key, title, docs, synced_at, full_at, error, attempts, synced_stamp >= stamp AS current FROM chats ORDER BY title').all()
      .map(r => ({ key: r.key, title: r.title, docs: r.docs, syncedAt: r.synced_at, fullAt: r.full_at, current: !!r.current && !r.error, error: r.error, attempts: r.attempts }));
  }
}
