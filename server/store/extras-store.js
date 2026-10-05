// ExtrasStore: ClawChats-only data the gateway has no place for. Lives in the global DB.
// Registry of what belongs here: EXTRAS.md at the repo root.
//
//   project_styles  color/icon and new-chat preset per gateway session group (groups are just {name, position})
//   thread_extras   per-session ClawChats data (Intelligence panel etc.), keyed by session key
//   legacy_created  creation time of chats from before the gateway recorded createdAt
//   bookmarks       messages the user bookmarked, keyed by id; one per (session key, message id)

// New-chat preset: what a new chat in the project starts with. Every field is optional;
// a missing field means the gateway default. `cwd` and `projectId` are exclusive places.
const PRESET_STRINGS = ['agentId', 'cwd', 'projectId', 'projectLabel', 'permissionMode', 'model', 'thinkingLevel'];
const PERMISSION_MODES = new Set(['read-only', 'guarded', 'workspace', 'full']);

export function cleanPreset(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {};
  for (const k of PRESET_STRINGS) {
    if (typeof p[k] === 'string' && p[k].trim()) out[k] = p[k].trim().slice(0, 1000);
  }
  if (out.permissionMode && !PERMISSION_MODES.has(out.permissionMode)) delete out.permissionMode;
  if (out.projectId) delete out.cwd;
  else delete out.projectLabel;
  if (typeof p.fastMode === 'boolean') out.fastMode = p.fastMode;
  return Object.keys(out).length ? out : null;
}

function parsePreset(text) {
  if (!text) return null;
  try { return cleanPreset(JSON.parse(text)); } catch { return null; }
}

const str = (v) => typeof v === 'string' && v.trim() ? v.trim() : '';
const clip = (v, n) => str(v).slice(0, n);

function bookmarkRow(r) {
  return {
    id: r.id, sessionKey: r.session_key, messageId: r.message_id, role: r.role, label: r.label,
    snippet: r.snippet, chatTitle: r.chat_title, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createExtrasStore(getGlobalDb) {
  let ready = false;
  function db() {
    const g = getGlobalDb();
    if (!ready) {
      g.exec(`CREATE TABLE IF NOT EXISTS project_styles (name TEXT PRIMARY KEY, color TEXT, icon TEXT, updated_at INTEGER NOT NULL)`);
      if (!g.prepare('PRAGMA table_info(project_styles)').all().some(c => c.name === 'preset')) g.exec('ALTER TABLE project_styles ADD COLUMN preset TEXT');
      g.exec(`CREATE TABLE IF NOT EXISTS legacy_created (session_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`);
      g.exec(`CREATE TABLE IF NOT EXISTS thread_extras (session_key TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_key, kind))`);
      g.exec(`CREATE TABLE IF NOT EXISTS bookmarks (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT, label TEXT NOT NULL, snippet TEXT NOT NULL, chat_title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (session_key, message_id))`);
      ready = true;
    }
    return g;
  }

  return {
    /** { [groupName]: { color, icon, preset } } */
    getProjectStyles() {
      const out = {};
      for (const r of db().prepare('SELECT name, color, icon, preset FROM project_styles').all()) {
        out[r.name] = { color: r.color, icon: r.icon, preset: parsePreset(r.preset) };
      }
      return out;
    },

    /** Set color, icon and/or new-chat preset; absent fields keep their value, null clears. */
    setProjectStyle(name, { color, icon, preset } = {}) {
      if (!name) return;
      const cur = db().prepare('SELECT color, icon, preset FROM project_styles WHERE name = ?').get(name) || {};
      const nextPreset = preset === undefined ? (cur.preset ?? null) : (cleanPreset(preset) ? JSON.stringify(cleanPreset(preset)) : null);
      db().prepare('INSERT INTO project_styles (name, color, icon, preset, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET color = excluded.color, icon = excluded.icon, preset = excluded.preset, updated_at = excluded.updated_at')
        .run(name, color !== undefined ? color : (cur.color ?? null), icon !== undefined ? icon : (cur.icon ?? null), nextPreset, Date.now());
    },

    renameProjectStyle(from, to) {
      if (!from || !to || from === to) return;
      const g = db();
      g.exec('BEGIN');
      try {
        g.prepare('DELETE FROM project_styles WHERE name = ?').run(to);
        g.prepare('UPDATE project_styles SET name = ?, updated_at = ? WHERE name = ?').run(to, Date.now(), from);
        g.exec('COMMIT');
      } catch (e) { g.exec('ROLLBACK'); throw e; }
    },

    deleteProjectStyle(name) {
      if (name) db().prepare('DELETE FROM project_styles WHERE name = ?').run(name);
    },

    /**
     * Copy styles of legacy projects (workspaces.json) that have none yet. Never overwrites,
     * so a style set through the gateway-native UI wins over the legacy file.
     */
    seedFromWorkspaces(workspaces) {
      const ins = db().prepare('INSERT OR IGNORE INTO project_styles (name, color, icon, updated_at) VALUES (?, ?, ?, ?)');
      let n = 0;
      for (const p of Object.values(workspaces?.workspaces || {})) {
        if (p?.label && (p.color || p.icon)) n += ins.run(p.label, p.color || null, p.icon || null, Date.now()).changes;
      }
      return n;
    },

    /** Store legacy creation times ([{ sessionKey, createdAt }]); never overwrites. */
    seedLegacyCreatedAt(rows) {
      const ins = db().prepare('INSERT OR IGNORE INTO legacy_created (session_key, created_at) VALUES (?, ?)');
      let n = 0;
      for (const r of rows || []) if (r?.sessionKey && r.createdAt > 0) n += ins.run(r.sessionKey, r.createdAt).changes;
      return n;
    },

    /** Map of session key -> legacy creation time (ms). */
    getLegacyCreatedAt() {
      return new Map(db().prepare('SELECT session_key, created_at FROM legacy_created').all().map(r => [r.session_key, r.created_at]));
    },

    getThreadExtra(sessionKey, kind) {
      const r = db().prepare('SELECT data FROM thread_extras WHERE session_key = ? AND kind = ?').get(sessionKey, kind);
      return r ? JSON.parse(r.data) : null;
    },

    setThreadExtra(sessionKey, kind, data) {
      db().prepare('INSERT INTO thread_extras (session_key, kind, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_key, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .run(sessionKey, kind, JSON.stringify(data), Date.now());
    },

    deleteThreadExtras(sessionKey) {
      if (!sessionKey) return;
      db().prepare('DELETE FROM thread_extras WHERE session_key = ?').run(sessionKey);
      db().prepare('DELETE FROM bookmarks WHERE session_key = ?').run(sessionKey);
    },

    /** All bookmarks, newest first. */
    listBookmarks() {
      return db().prepare('SELECT * FROM bookmarks ORDER BY created_at DESC').all().map(bookmarkRow);
    },

    /** Bookmark a message; bookmarking it again returns the existing bookmark unchanged. */
    addBookmark(id, { sessionKey, messageId, role, label, snippet, chatTitle } = {}) {
      if (!id || !str(sessionKey) || !str(messageId)) return null;
      const now = Date.now();
      db().prepare('INSERT INTO bookmarks (id, session_key, message_id, role, label, snippet, chat_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_key, message_id) DO NOTHING')
        .run(id, sessionKey, messageId, role === 'user' ? 'user' : 'assistant', clip(label, 200) || 'Bookmark', clip(snippet, 600), clip(chatTitle, 200) || null, now, now);
      return bookmarkRow(db().prepare('SELECT * FROM bookmarks WHERE session_key = ? AND message_id = ?').get(sessionKey, messageId));
    },

    /** Rename; returns the updated bookmark, or null if it doesn't exist. */
    renameBookmark(id, label) {
      const l = clip(label, 200);
      if (!l) return null;
      db().prepare('UPDATE bookmarks SET label = ?, updated_at = ? WHERE id = ?').run(l, Date.now(), id);
      const r = db().prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
      return r ? bookmarkRow(r) : null;
    },

    deleteBookmark(id) {
      return db().prepare('DELETE FROM bookmarks WHERE id = ?').run(id).changes > 0;
    },
  };
}
