import fs from 'node:fs';
import path from 'node:path';
import { send, sendError, parseBody, uuid } from '../util/http.js';
import { syncThreadUnreadCount } from '../util/helpers.js';
import { getSessionsDirForAgent } from '../config.js';
import { cleanGatewaySession } from '../gateway-cleanup.js';

export class ThreadController {
  constructor({ getActiveDb, getWorkspaces, getRequestWorkspace, uploadsDir, broadcast }) {
    this.getActiveDb = getActiveDb;
    this.getWorkspaces = getWorkspaces;
    this.getRequestWorkspace = getRequestWorkspace;
    this.uploadsDir = uploadsDir;
    this.broadcast = broadcast;
  }

  getAll(req, res, params, query) {
    const db = this.getActiveDb();
    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '50', 10), 200);
    const offset = (page - 1) * limit;
    const search = query.search || '';
    let threads, total;
    if (search) {
      try {
        const matchingIds = db.prepare(`SELECT DISTINCT m.thread_id FROM messages m JOIN messages_fts ON messages_fts.rowid = m.rowid WHERE messages_fts MATCH ?`).all(search).map(r => r.thread_id);
        if (!matchingIds.length) return send(res, 200, { threads: [], total: 0, page });
        const ph = matchingIds.map(() => '?').join(',');
        total = db.prepare(`SELECT COUNT(*) as c FROM threads WHERE id IN (${ph})`).get(...matchingIds).c;
        threads = db.prepare(`SELECT t.*, EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id AND role = 'assistant' AND json_extract(metadata, '$.pending') = 1) as has_pending FROM threads t WHERE t.id IN (${ph}) ORDER BY t.pinned DESC, t.sort_order DESC, t.updated_at DESC LIMIT ? OFFSET ?`).all(...matchingIds, limit, offset);
      } catch { return send(res, 200, { threads: [], total: 0, page }); }
    } else {
      total = db.prepare('SELECT COUNT(*) as c FROM threads').get().c;
      threads = db.prepare(`SELECT t.*, EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id AND role = 'assistant' AND json_extract(metadata, '$.pending') = 1) as has_pending FROM threads t ORDER BY t.pinned DESC, t.sort_order DESC, t.updated_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    }
    send(res, 200, { threads, total, page });
  }

  getUnread(req, res) {
    const db = this.getActiveDb();
    const threads = db.prepare(`SELECT t.id, t.title, t.unread_count, m.content as lastMessage FROM threads t LEFT JOIN messages m ON m.thread_id = t.id WHERE t.unread_count > 0 AND m.timestamp = (SELECT MAX(timestamp) FROM messages WHERE thread_id = t.id) ORDER BY t.updated_at DESC`).all();
    for (const t of threads) t.unreadMessageIds = db.prepare('SELECT message_id FROM unread_messages WHERE thread_id = ?').all(t.id).map(r => r.message_id);
    send(res, 200, { threads });
  }

  async markRead(req, res, params) {
    const { messageIds } = await parseBody(req);
    if (!Array.isArray(messageIds) || !messageIds.length) return send(res, 400, { error: 'messageIds array required' });
    const db = this.getActiveDb();
    const ph = messageIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM unread_messages WHERE thread_id = ? AND message_id IN (${ph})`).run(params.id, ...messageIds);
    const remaining = syncThreadUnreadCount(db, params.id);
    // Name the workspace this request targeted: app.js routes unread-update by the
    // `workspace` field (`workspace === this.activeWorkspace`), so labelling it with
    // the process-global active workspace clears the wrong badge — see CLA-1279.
    this.broadcast(JSON.stringify({ type: 'clawchats', event: 'unread-update', workspace: this.getRequestWorkspace(), threadId: params.id, action: 'read', messageIds, unreadCount: remaining, timestamp: Date.now() }));
    send(res, 200, { unread_count: remaining });
  }

  async create(req, res) {
    const body = await parseBody(req);
    const db = this.getActiveDb();
    const ws = this.getWorkspaces();
    const id = body.id || uuid();
    const now = Date.now();
    // Key the thread to the workspace this request targets (x-workspace), not the
    // process-global active one — the row is written to the targeted workspace's db,
    // and parseSessionKey() routes gateway events back by this key.
    const workspace = this.getRequestWorkspace();
    const agent = ws.workspaces[workspace]?.agent || 'main';
    try {
      db.prepare('INSERT INTO threads (id, session_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, `agent:${agent}:${workspace}:chat:${id}`, 'New chat', now, now);
    } catch (e) {
      if (e.message.includes('UNIQUE constraint')) return sendError(res, 409, 'Thread already exists');
      throw e;
    }
    send(res, 201, { thread: db.prepare('SELECT * FROM threads WHERE id = ?').get(id) });
  }

  get(req, res, params) {
    const thread = this.getActiveDb().prepare('SELECT * FROM threads WHERE id = ?').get(params.id);
    if (!thread) return sendError(res, 404, 'Thread not found');
    send(res, 200, { thread });
  }

  async update(req, res, params) {
    const body = await parseBody(req);
    const db = this.getActiveDb();
    if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(params.id)) return sendError(res, 404, 'Thread not found');
    const fields = [], values = [];
    for (const [col, val] of [['title', body.title], ['model', body.model], ['last_session_id', body.last_session_id], ['unread_count', body.unread_count]]) {
      if (val !== undefined) { fields.push(`${col} = ?`); values.push(val); }
    }
    if (body.pinned !== undefined) { fields.push('pinned = ?'); values.push(body.pinned ? 1 : 0); }
    if (body.pin_order !== undefined) { fields.push('pin_order = ?'); values.push(body.pin_order); }
    if (body.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(body.sort_order); }
    if (body.metadata !== undefined) { fields.push('metadata = ?'); values.push(typeof body.metadata === 'string' ? body.metadata : JSON.stringify(body.metadata)); }
    if (fields.length) {
      fields.push('updated_at = ?');
      values.push(Date.now(), params.id);
      db.prepare(`UPDATE threads SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }
    send(res, 200, { thread: db.prepare('SELECT * FROM threads WHERE id = ?').get(params.id) });
  }

  delete(req, res, params) {
    const db = this.getActiveDb();
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(params.id);
    if (!thread) return sendError(res, 404, 'Thread not found');
    db.prepare('DELETE FROM threads WHERE id = ?').run(params.id);
    const agentMatch = (thread.session_key || '').match(/^agent:([^:]+):/);
    const sessionsDir = getSessionsDirForAgent(agentMatch?.[1]);
    let sessionIdToDelete = thread.last_session_id;
    if (!sessionIdToDelete) {
      try { sessionIdToDelete = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8'))[thread.session_key]?.sessionId; } catch { /* ok */ }
    }
    cleanGatewaySession(thread.session_key);
    if (sessionIdToDelete) { try { fs.unlinkSync(path.join(sessionsDir, `${sessionIdToDelete}.jsonl`)); } catch { /* ok */ } }
    try { fs.rmSync(path.join(this.uploadsDir, params.id), { recursive: true }); } catch { /* ok */ }
    send(res, 200, { ok: true });
  }
}
