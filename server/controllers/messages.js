import { send, sendError, parseBody } from '../util/http.js';
import { buildContextPreamble } from '../util/context.js';
import { parseSessionKey } from '../util/helpers.js';

export class MessageController {
  constructor({ getActiveDb, getWorkspaces, getRequestWorkspace, broadcast }) {
    this.getActiveDb = getActiveDb;
    this.getWorkspaces = getWorkspaces;
    this.getRequestWorkspace = getRequestWorkspace;
    this.broadcast = broadcast;
  }

  getAll(req, res, params, query) {
    const db = this.getActiveDb();
    if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(params.id)) return sendError(res, 404, 'Thread not found');
    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    const before = query.before ? parseInt(query.before, 10) : null;
    const after = query.after ? parseInt(query.after, 10) : null;
    let sql = 'SELECT * FROM messages WHERE thread_id = ?';
    const sqlParams = [params.id];
    if (before) { sql += ' AND timestamp < ?'; sqlParams.push(before); }
    if (after) { sql += ' AND timestamp > ?'; sqlParams.push(after); }
    const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) as c')).get(...sqlParams).c;
    const rows = db.prepare(sql + ' ORDER BY timestamp DESC LIMIT ?').all(...sqlParams, limit + 1);
    const messages = rows.slice(0, limit).reverse();
    for (const m of messages) { if (m.metadata) { try { m.metadata = JSON.parse(m.metadata); } catch { /* ok */ } } }
    send(res, 200, { messages, hasMore: rows.length > limit });
  }

  async create(req, res, params) {
    const body = await parseBody(req);
    const db = this.getActiveDb();
    if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(params.id)) return sendError(res, 404, 'Thread not found');
    if (!body.id || !body.role || body.content === undefined || !body.timestamp) return sendError(res, 400, 'Required: id, role, content, timestamp');
    const metadata = body.metadata ? JSON.stringify(body.metadata) : null;
    const existing = db.prepare('SELECT id, status, metadata FROM messages WHERE id = ?').get(body.id);
    if (existing) {
      db.prepare('UPDATE messages SET status = ?, content = ?, metadata = ? WHERE id = ?').run(body.status || existing.status, body.content, metadata || existing.metadata, body.id);
    } else {
      db.prepare('INSERT INTO messages (id, thread_id, role, content, status, metadata, seq, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(body.id, params.id, body.role, body.content, body.status || 'sent', metadata, body.seq || null, body.timestamp, Date.now());
      db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), params.id);
      if (body.role === 'user' && body.content) {
        const thread = db.prepare('SELECT title FROM threads WHERE id = ?').get(params.id);
        if (thread?.title === 'New chat') {
          const title = body.content.replace(/\n.*/s, '').slice(0, 40).trim() + (body.content.length > 40 ? '...' : '');
          if (title) {
            db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, params.id);
            this.broadcast(JSON.stringify({ type: 'clawchats', event: 'thread-title-updated', threadId: params.id, workspace: this.getRequestWorkspace(), title }));
          }
        }
      }
    }
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(body.id);
    if (message?.metadata) { try { message.metadata = JSON.parse(message.metadata); } catch { /* ok */ } }
    send(res, existing ? 200 : 201, { message });
  }

  delete(req, res, params) {
    const db = this.getActiveDb();
    if (!db.prepare('SELECT id FROM messages WHERE id = ? AND thread_id = ?').get(params.messageId, params.id)) return sendError(res, 404, 'Message not found');
    db.prepare('DELETE FROM messages WHERE id = ?').run(params.messageId);
    send(res, 200, { ok: true });
  }

  contextFill(req, res, params) {
    const db = this.getActiveDb();
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(params.id);
    if (!thread) return sendError(res, 404, 'Thread not found');
    send(res, 200, buildContextPreamble(db, params.id, thread.last_session_id, thread.session_key));
  }

  search(req, res, params, query) {
    const q = query.q || '';
    if (!q) return send(res, 200, { results: [], total: 0 });
    const db = this.getActiveDb();
    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const offset = (page - 1) * limit;
    try {
      const results = db.prepare(`SELECT m.id as messageId, m.thread_id as threadId, t.title as threadTitle, m.role, snippet(messages_fts, 0, '<mark>', '</mark>', '...', 40) as content, m.timestamp FROM messages_fts JOIN messages m ON messages_fts.rowid = m.rowid JOIN threads t ON m.thread_id = t.id WHERE messages_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?`).all(q, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH ?`).get(q).c;
      send(res, 200, { results, total });
    } catch { send(res, 200, { results: [], total: 0 }); }
  }

  export(req, res) {
    const db = this.getActiveDb();
    const threads = db.prepare('SELECT * FROM threads ORDER BY updated_at DESC').all();
    send(res, 200, {
      // The dump is of the targeted workspace's database, so it must name that
      // workspace — import() mints session keys from this label — see CLA-1279.
      workspace: this.getRequestWorkspace(),
      exportedAt: Date.now(),
      threads: threads.map(t => {
        const messages = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY timestamp ASC').all(t.id);
        for (const m of messages) { if (m.metadata) { try { m.metadata = JSON.parse(m.metadata); } catch { /* ok */ } } }
        return { ...t, messages };
      }),
    });
  }

  async import(req, res) {
    const body = await parseBody(req);
    const db = this.getActiveDb();
    const ws = this.getWorkspaces();
    // Imported threads without a usable key are minted against the targeted
    // workspace, matching ThreadController.create — see CLA-1274.
    const workspace = this.getRequestWorkspace();
    if (!body.threads || !Array.isArray(body.threads)) return sendError(res, 400, 'Expected { threads: [...] }');
    let threadsImported = 0, messagesImported = 0;
    const insertThread = db.prepare('INSERT OR IGNORE INTO threads (id, session_key, title, pinned, pin_order, model, last_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertMsg = db.prepare('INSERT OR IGNORE INTO messages (id, thread_id, role, content, status, metadata, seq, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const t of body.threads) {
        if (!t.id) continue;
        // CLA-1296: session_key arrives from the client, so it is honoured only when
        // it parses and already describes this row — same workspace, same thread id.
        // The database file a row lives in is ground truth for which workspace owns
        // it (CLA-1274), and gateway replies are routed by parsing this key: a key
        // naming another workspace persists this thread's replies into that
        // workspace's database. Importing a dump into a workspace other than the one
        // it was exported from does exactly that. Anything unusable is re-minted,
        // which is the state repairSessionKeyWorkspace() converges to on the next
        // open anyway — done here so there is no window before that restart.
        const parsed = parseSessionKey(t.session_key);
        const sessionKey = parsed && parsed.workspace === workspace && parsed.threadId === t.id
          ? t.session_key
          : `agent:${ws.workspaces[workspace]?.agent || 'main'}:${workspace}:chat:${t.id}`;
        if (insertThread.run(t.id, sessionKey, t.title || 'Imported chat', t.pinned || 0, t.pin_order || 0, t.model || null, t.last_session_id || null, t.created_at || Date.now(), t.updated_at || Date.now()).changes > 0) threadsImported++;
        for (const m of (t.messages || [])) {
          if (!m.id || !m.role) continue;
          const meta = m.metadata ? (typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata)) : null;
          if (insertMsg.run(m.id, t.id, m.role, m.content || '', m.status || 'sent', meta, m.seq || null, m.timestamp || Date.now(), m.created_at || Date.now()).changes > 0) messagesImported++;
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    send(res, 200, { ok: true, threadsImported, messagesImported });
  }
}
