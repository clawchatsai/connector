// TagStore: chat summaries and tags (global.db). Unlike the search index this is not derived data:
// every row cost a model call or is a user's edit, so a search Rebuild never touches it.
//
//   chat_tags    per chat: the model's summary, tags and keywords; the user's added/removed tags
//                (applied on top, so a re-tag never undoes an edit); when and from how many messages
//                it was tagged; the last failure for the retry backoff
//   tag_aliases  user renames and deletions (target '' = deleted), applied to future model output
//   tag_meta     settings and progress: enabled, since, backfill, legacy import

import { effectiveTags, normalizeTag } from './model.js';

const list = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

function rowOut(r) {
  const auto = list(r.auto_tags), added = list(r.added), removed = list(r.removed);
  return {
    key: r.session_key, summary: r.summary, tags: effectiveTags({ auto, added, removed }), auto, added, removed,
    keywords: list(r.keywords), source: r.source, model: r.model, messages: r.messages, taggedAt: r.tagged_at,
    costUsd: r.cost_usd, error: r.error, errorAt: r.error_at, attempts: r.attempts,
  };
}

export function createTagStore(getGlobalDb, { now = () => Date.now() } = {}) {
  let ready = false;
  function db() {
    const g = getGlobalDb();
    if (!ready) {
      g.exec(`CREATE TABLE IF NOT EXISTS chat_tags (
        session_key TEXT PRIMARY KEY, summary TEXT NOT NULL DEFAULT '', auto_tags TEXT NOT NULL DEFAULT '[]',
        added TEXT NOT NULL DEFAULT '[]', removed TEXT NOT NULL DEFAULT '[]', keywords TEXT NOT NULL DEFAULT '[]',
        source TEXT, model TEXT, messages INTEGER NOT NULL DEFAULT 0, tagged_at INTEGER, cost_usd REAL,
        error TEXT, error_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
      g.exec('CREATE TABLE IF NOT EXISTS tag_aliases (tag TEXT PRIMARY KEY, target TEXT NOT NULL)');
      g.exec('CREATE TABLE IF NOT EXISTS tag_meta (k TEXT PRIMARY KEY, v TEXT)');
      ready = true;
    }
    return g;
  }
  const tx = fn => { const g = db(); g.exec('BEGIN IMMEDIATE'); try { const r = fn(g); g.exec('COMMIT'); return r; } catch (e) { g.exec('ROLLBACK'); throw e; } };
  const getRow = (g, key) => g.prepare('SELECT * FROM chat_tags WHERE session_key = ?').get(key);
  const ensure = (g, key) => g.prepare('INSERT OR IGNORE INTO chat_tags (session_key, updated_at) VALUES (?, ?)').run(key, now());

  const store = {
    meta(k) { return db().prepare('SELECT v FROM tag_meta WHERE k = ?').get(k)?.v ?? null; },
    setMeta(k, v) {
      if (v == null) db().prepare('DELETE FROM tag_meta WHERE k = ?').run(k);
      else db().prepare('INSERT INTO tag_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
    },

    get(key) { const r = getRow(db(), key); return r ? rowOut(r) : null; },
    all() { return db().prepare('SELECT * FROM chat_tags').all().map(rowOut); },
    keys() { return db().prepare('SELECT session_key FROM chat_tags').all().map(r => r.session_key); },
    delete(key) { return db().prepare('DELETE FROM chat_tags WHERE session_key = ?').run(key).changes > 0; },

    /** Map tag → target ('' = deleted). */
    aliases() { return new Map(db().prepare('SELECT tag, target FROM tag_aliases').all().map(r => [r.tag, r.target])); },

    /** Tags in use with how many chats carry each, most used first. */
    vocabulary() {
      const counts = new Map();
      for (const r of store.all()) for (const t of r.tags) counts.set(t, (counts.get(t) || 0) + 1);
      return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    },

    /** The model's result for a chat; the user's added/removed tags stay. */
    saveAuto(key, { summary, tags, keywords, model = null, messages = 0, costUsd = null, source = 'auto' }) {
      tx(g => {
        ensure(g, key);
        g.prepare(`UPDATE chat_tags SET summary = ?, auto_tags = ?, keywords = ?, source = ?, model = ?, messages = ?, tagged_at = ?,
          cost_usd = ?, error = NULL, error_at = NULL, attempts = 0, updated_at = ? WHERE session_key = ?`)
          .run(summary || '', JSON.stringify(tags || []), JSON.stringify(keywords || []), source, model, messages, now(), costUsd, now(), key);
      });
      return store.get(key);
    },

    markFailed(key, message) {
      tx(g => {
        ensure(g, key);
        g.prepare('UPDATE chat_tags SET error = ?, error_at = ?, attempts = attempts + 1, updated_at = ? WHERE session_key = ?').run(String(message).slice(0, 500), now(), now(), key);
      });
    },

    /** User edit on one chat: add and/or remove tags (normalized; aliases apply). Returns the chat's row. */
    edit(key, { add = [], remove = [] }) {
      const aliases = store.aliases();
      return tx(g => {
        ensure(g, key);
        const r = rowOut(getRow(g, key));
        const added = new Set(r.added), removed = new Set(r.removed);
        for (const raw of remove) {
          const t = normalizeTag(raw) || String(raw);
          added.delete(t);
          if (r.auto.includes(t)) removed.add(t);
        }
        for (const raw of add) {
          const t = normalizeTag(raw, { aliases });
          if (!t) continue;
          removed.delete(t);
          if (!r.auto.includes(t)) added.add(t);
        }
        g.prepare('UPDATE chat_tags SET added = ?, removed = ?, updated_at = ? WHERE session_key = ?').run(JSON.stringify([...added]), JSON.stringify([...removed]), now(), key);
        return rowOut(getRow(g, key));
      });
    },

    /**
     * Rename `from` to `to` everywhere (a merge when `to` is already in use), or delete it (`to` = '').
     * Future model output follows (alias). Returns the keys of the chats that changed.
     */
    renameTag(from, to) {
      return tx(g => {
        g.prepare('INSERT INTO tag_aliases (tag, target) VALUES (?, ?) ON CONFLICT(tag) DO UPDATE SET target = excluded.target').run(from, to);
        if (to) {
          g.prepare('DELETE FROM tag_aliases WHERE tag = ?').run(to); // `to` is a live tag again
          g.prepare('UPDATE tag_aliases SET target = ? WHERE target = ?').run(to, from);
        }
        const changed = [];
        const swap = arr => { const out = []; for (const t of arr) { const v = t === from ? to : t; if (v && !out.includes(v)) out.push(v); } return out; };
        for (const r of g.prepare('SELECT * FROM chat_tags').all().map(rowOut)) {
          if (![r.auto, r.added, r.removed].some(a => a.includes(from))) continue;
          const auto = swap(r.auto), removed = swap(r.removed);
          const added = swap(r.added).filter(t => !auto.includes(t));
          g.prepare('UPDATE chat_tags SET auto_tags = ?, added = ?, removed = ?, updated_at = ? WHERE session_key = ?')
            .run(JSON.stringify(auto), JSON.stringify(added), JSON.stringify(removed), now(), r.key);
          changed.push(r.key);
        }
        return changed;
      });
    },

    /** Legacy (pre-gateway ClawChats) summaries, for chats without a row yet. Returns how many were added. */
    importLegacy(rows) {
      return tx(g => {
        const put = g.prepare(`INSERT OR IGNORE INTO chat_tags (session_key, summary, keywords, source, messages, tagged_at, updated_at)
          VALUES (?, ?, ?, 'legacy', ?, ?, ?)`);
        let n = 0;
        for (const r of rows) n += put.run(r.key, r.summary || '', JSON.stringify(r.keywords || []), r.messages || 0, r.taggedAt || now(), now()).changes;
        return n;
      });
    },
  };
  return store;
}
