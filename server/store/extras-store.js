// ExtrasStore: ClawChats-only data the gateway has no place for. Lives in the global DB.
// Registry of what belongs here: EXTRAS.md at the repo root.
//
//   project_styles  color/icon per gateway session group (groups are just {name, position})
//   thread_extras   per-session ClawChats data (Intelligence panel etc.), keyed by session key

export function createExtrasStore(getGlobalDb) {
  let ready = false;
  function db() {
    const g = getGlobalDb();
    if (!ready) {
      g.exec(`CREATE TABLE IF NOT EXISTS project_styles (name TEXT PRIMARY KEY, color TEXT, icon TEXT, updated_at INTEGER NOT NULL)`);
      g.exec(`CREATE TABLE IF NOT EXISTS thread_extras (session_key TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_key, kind))`);
      ready = true;
    }
    return g;
  }

  return {
    /** { [groupName]: { color, icon } } */
    getProjectStyles() {
      const out = {};
      for (const r of db().prepare('SELECT name, color, icon FROM project_styles').all()) out[r.name] = { color: r.color, icon: r.icon };
      return out;
    },

    /** Set color and/or icon; absent fields keep their value, null clears. */
    setProjectStyle(name, { color, icon } = {}) {
      if (!name) return;
      const cur = db().prepare('SELECT color, icon FROM project_styles WHERE name = ?').get(name) || {};
      db().prepare('INSERT INTO project_styles (name, color, icon, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET color = excluded.color, icon = excluded.icon, updated_at = excluded.updated_at')
        .run(name, color !== undefined ? color : (cur.color ?? null), icon !== undefined ? icon : (cur.icon ?? null), Date.now());
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

    getThreadExtra(sessionKey, kind) {
      const r = db().prepare('SELECT data FROM thread_extras WHERE session_key = ? AND kind = ?').get(sessionKey, kind);
      return r ? JSON.parse(r.data) : null;
    },

    setThreadExtra(sessionKey, kind, data) {
      db().prepare('INSERT INTO thread_extras (session_key, kind, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_key, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .run(sessionKey, kind, JSON.stringify(data), Date.now());
    },

    deleteThreadExtras(sessionKey) {
      if (sessionKey) db().prepare('DELETE FROM thread_extras WHERE session_key = ?').run(sessionKey);
    },
  };
}
