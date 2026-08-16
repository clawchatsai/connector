import fs from 'node:fs';
import path from 'node:path';
import { send, sendError, parseBody, uuid } from '../util/http.js';
import { syncThreadUnreadCount } from '../util/helpers.js';
import { getSessionsDirForAgent } from '../config.js';
import { cleanGatewaySession, renameGatewaySession } from '../gateway-cleanup.js';
import { intelligencePath } from './files.js';

// node:sqlite's DatabaseSync has no better-sqlite3-style db.transaction(); drive it
// explicitly, as POST /api/prompts does.
function inTransaction(db, fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Both workspace databases are built by the same migrate(), so a row's own keys are
// the column list. Hardcoding one rots the moment a migration adds a column — the
// threads table has already grown sort_order, unread_count and metadata that way.
function copyRows(db, table, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const insert = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const row of rows) insert.run(...cols.map(c => row[c]));
}

export class ThreadController {
  constructor({ getDb, getActiveDb, getWorkspaces, getRequestWorkspace, uploadsDir, intelligenceDir, broadcast }) {
    this.getDb = getDb;
    this.getActiveDb = getActiveDb;
    this.getWorkspaces = getWorkspaces;
    this.getRequestWorkspace = getRequestWorkspace;
    this.uploadsDir = uploadsDir;
    this.intelligenceDir = intelligenceDir;
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

  // Move a thread, its messages and its unread bookkeeping into another workspace's
  // database. Body key is `workspace`, matching what the frontend already sends
  // (clawchats PR #164, `moveChat()`).
  async move(req, res, params) {
    const body = await parseBody(req);
    const target = body.workspace;
    if (typeof target !== 'string' || !target) return sendError(res, 400, 'workspace is required');

    // Object.hasOwn, not a plain read: "constructor" resolves on the prototype, and
    // getDb() would then mint a database for a workspace nobody registered (CLA-1331).
    const ws = this.getWorkspaces();
    if (!Object.hasOwn(ws.workspaces, target)) return sendError(res, 404, 'Target workspace not found');

    // The workspace this request targets (x-workspace), never the process-global
    // active one: moving a thread out of A while B happens to be active has to read
    // and delete from A. Same reasoning as CLA-1279.
    const source = this.getRequestWorkspace();
    if (source === target) return sendError(res, 400, 'Thread is already in this workspace');

    const srcDb = this.getActiveDb();
    const thread = srcDb.prepare('SELECT * FROM threads WHERE id = ?').get(params.id);
    if (!thread) return sendError(res, 404, 'Thread not found');

    const tgtDb = this.getDb(target);
    // Thread ids are not unique across workspaces — POST /api/import preserves
    // caller-supplied ids — so refuse rather than overwrite the target's thread.
    if (tgtDb.prepare('SELECT id FROM threads WHERE id = ?').get(params.id)) {
      return sendError(res, 409, 'A thread with this id already exists in the target workspace');
    }

    const messages = srcDb.prepare('SELECT * FROM messages WHERE thread_id = ?').all(params.id);
    const unread = srcDb.prepare('SELECT * FROM unread_messages WHERE thread_id = ?').all(params.id);
    // Re-key to the target, or parseSessionKey() would keep routing this thread's
    // gateway events at the workspace it just left.
    const newSessionKey = `agent:${ws.workspaces[target].agent || 'main'}:${target}:chat:${params.id}`;

    // SQLite offers no cross-database atomicity: a transaction spanning two ATTACHed
    // databases is documented as non-atomic once either is in WAL mode, and both of
    // ours are. So the halves run in order, each in its own transaction, ordered so
    // that any failure leaves the thread intact in exactly one workspace — the target
    // write commits first, and only then is the source deleted.
    inTransaction(tgtDb, () => {
      copyRows(tgtDb, 'threads', [{ ...thread, session_key: newSessionKey }]);
      copyRows(tgtDb, 'messages', messages);
      copyRows(tgtDb, 'unread_messages', unread);
    });
    try {
      // Messages and unread rows go with it: both cascade off threads.id, and the
      // cascade fires the messages_ad trigger, so the source FTS index is cleaned too.
      // delete() relies on the same cascade.
      srcDb.prepare('DELETE FROM threads WHERE id = ?').run(params.id);
    } catch (e) {
      // Undo the copy, so a failed second half cannot leave the thread live in both
      // workspaces. The source is the copy that survives.
      try { tgtDb.prepare('DELETE FROM threads WHERE id = ?').run(params.id); }
      catch (undoErr) { console.error(`[move] thread ${params.id} was copied to "${target}" but both the source delete and its undo failed:`, undoErr.message); }
      throw e;
    }

    // Sidecars that are keyed by workspace have to follow the thread. Uploads do not:
    // they live under uploadsDir/<threadId>, which no workspace name enters.
    renameGatewaySession(thread.session_key, newSessionKey);
    const fromPath = intelligencePath(this.intelligenceDir, source, params.id);
    if (fs.existsSync(fromPath)) {
      const toPath = intelligencePath(this.intelligenceDir, target, params.id);
      try { fs.mkdirSync(path.dirname(toPath), { recursive: true }); fs.renameSync(fromPath, toPath); }
      catch (err) { console.warn(`[move] intelligence for thread ${params.id} left in "${source}":`, err.message); }
    }

    this.broadcast(JSON.stringify({ type: 'clawchats', event: 'thread-moved', threadId: params.id, fromWorkspace: source, toWorkspace: target, timestamp: Date.now() }));
    send(res, 200, { ok: true, thread: tgtDb.prepare('SELECT * FROM threads WHERE id = ?').get(params.id) });
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
