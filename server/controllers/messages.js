import { send, sendError, parseBody } from '../util/http.js';
import { buildContextPreamble } from '../util/context.js';

export class MessageController {
  constructor({ getActiveDb, getWorkspaces, broadcast }) {
    this.getActiveDb = getActiveDb;
    this.getWorkspaces = getWorkspaces;
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
      if (body.status && body.status !== existing.status) {
        db.prepare('UPDATE messages SET status = ?, content = ?, metadata = ? WHERE id = ?').run(body.status, body.content, metadata || existing.metadata, body.id);
      }
    } else {
      db.prepare('INSERT INTO messages (id, thread_id, role, content, status, metadata, seq, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(body.id, params.id, body.role, body.content, body.status || 'sent', metadata, body.seq || null, body.timestamp, Date.now());
      db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), params.id);
      if (body.role === 'user' && body.content) {
        const thread = db.prepare('SELECT title FROM threads WHERE id = ?').get(params.id);
        if (thread?.title === 'New chat') {
          const title = body.content.replace(/\n.*/s, '').slice(0, 40).trim() + (body.content.length > 40 ? '...' : '');
          if (title) {
            db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, params.id);
            this.broadcast(JSON.stringify({ type: 'clawchats', event: 'thread-title-updated', threadId: params.id, workspace: this.getWorkspaces().active, title }));
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
    const ws = this.getWorkspaces();
    const threads = db.prepare('SELECT * FROM threads ORDER BY updated_at DESC').all();
    send(res, 200, {
      workspace: ws.active,
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
    if (!body.threads || !Array.isArray(body.threads)) return sendError(res, 400, 'Expected { threads: [...] }');
    let threadsImported = 0, messagesImported = 0;
    const insertThread = db.prepare('INSERT OR IGNORE INTO threads (id, session_key, title, pinned, pin_order, model, last_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertMsg = db.prepare('INSERT OR IGNORE INTO messages (id, thread_id, role, content, status, metadata, seq, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (const t of body.threads) {
        if (!t.id) continue;
        const sessionKey = t.session_key || `agent:main:${ws.active}:chat:${t.id}`;
        if (insertThread.run(t.id, sessionKey, t.title || 'Imported chat', t.pinned || 0, t.pin_order || 0, t.model || null, t.last_session_id || null, t.created_at || Date.now(), t.updated_at || Date.now()).changes > 0) threadsImported++;
        for (const m of (t.messages || [])) {
          if (!m.id || !m.role) continue;
          const meta = m.metadata ? (typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata)) : null;
          if (insertMsg.run(m.id, t.id, m.role, m.content || '', m.status || 'sent', meta, m.seq || null, m.timestamp || Date.now(), m.created_at || Date.now()).changes > 0) messagesImported++;
        }
      }
    })();
    send(res, 200, { ok: true, threadsImported, messagesImported });
  }
}
