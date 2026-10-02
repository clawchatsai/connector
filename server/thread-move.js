// Move a thread (row + messages + unread markers) between per-project SQLite files.
// Projects are separate databases, so a move is copy-then-delete: the target copy is
// committed before the source row is removed, so a failure never loses the thread.

const TABLES = ['threads', 'messages', 'unread_messages'];

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}

/**
 * @returns {boolean} true when the thread was moved, false when it wasn't in `from`.
 */
export function moveThread(getDb, threadId, from, to) {
  if (from === to) return false;
  const src = getDb(from);
  const dst = getDb(to);
  const thread = src.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
  if (!thread) return false;

  const rows = {
    threads: [thread],
    messages: src.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY timestamp, rowid').all(threadId),
    unread_messages: src.prepare('SELECT * FROM unread_messages WHERE thread_id = ?').all(threadId),
  };

  inTransaction(dst, () => {
    // A leftover copy from an interrupted earlier move is replaced (cascade clears its children).
    dst.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
    for (const table of TABLES) {
      if (!rows[table].length) continue;
      const dstCols = new Set(columns(dst, table));
      const cols = Object.keys(rows[table][0]).filter(c => dstCols.has(c));
      const stmt = dst.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of rows[table]) stmt.run(...cols.map(c => row[c] ?? null));
    }
  });

  inTransaction(src, () => { src.prepare('DELETE FROM threads WHERE id = ?').run(threadId); });
  return true;
}
