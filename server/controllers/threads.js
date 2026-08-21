import fs from 'node:fs';
import path from 'node:path';
import { send, sendError, parseBody, uuid } from '../util/http.js';
import { syncThreadUnreadCount } from '../util/helpers.js';
import { cleanGatewaySession, renameGatewaySession } from '../gateway-cleanup.js';
import { intelligencePath } from './files.js';
import { isValidWorkspaceName } from '../util/workspace-name.js';

// How many times move() re-tries withdrawing its target-side copy when the source
// delete fails. Small and synchronous — see the invariant note on move().
const UNDO_ATTEMPTS = 3;

// node:sqlite's DatabaseSync has no better-sqlite3-style db.transaction(); drive it
// explicitly, as POST /api/prompts does.
function inTransaction(db, fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  // A throwing ROLLBACK would replace the error that actually caused the failure with
  // a much less useful one, so it never escapes.
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* keep the original error */ } throw e; }
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
    // `last_session_id` is not in this list because CLA-1509 dropped the column. It
    // named a file in the gateway session store and nothing server-side ever wrote it,
    // so every value it could hold was chosen by a caller, for a store shared across
    // workspaces — CLA-1503. It is not coming back in this shape: a thread's current
    // session id is already derivable server-side from sessions.json, exactly as
    // gateway-cleanup.js reads it, so nothing here needs a client-writable column.
    for (const [col, val] of [['title', body.title], ['model', body.model], ['unread_count', body.unread_count]]) {
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
  //
  // parseBody() is the only `await` in this handler, and it is taken before any state
  // is read. Everything from the source lookup to the source delete is therefore one
  // uninterrupted synchronous block, which is the only reason two concurrent moves of
  // the same thread cannot interleave: the second request cannot observe the first
  // mid-move. Do not add an `await` below this line — it would silently reopen that
  // window and turn the id-collision check at :164 into a TOCTOU race.
  async move(req, res, params) {
    const body = await parseBody(req);
    const target = body.workspace;
    if (typeof target !== 'string' || !target) return sendError(res, 400, 'workspace is required');

    // The name reaches path.join() twice below — getDb()'s `<name>.db` and the
    // intelligence directory — so it goes through the shared validator rather than
    // trusting the registry to hold only names POST /api/workspaces vetted.
    // getWorkspaces() parses workspaces.json without validating its keys, so a
    // hand-edited, restored or older-version registry is enough to put "../../etc/foo"
    // in front of both. This is the third entry point for a workspace name; the other
    // two (the x-workspace header, workspace creation) already check here.
    if (!isValidWorkspaceName(target)) return sendError(res, 400, 'Invalid workspace name');

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
      // The target half has already committed, so the copy has to come back out or the
      // thread is live in both workspaces at once. Both databases are WAL files on the
      // same disk, so whatever broke the source delete — a full disk, a read-only
      // remount, SQLITE_BUSY under checkpoint pressure — is quite likely to break the
      // first undo attempt too. Hence the retry.
      //
      // The retry is deliberately synchronous: awaiting a backoff here would break the
      // single-`await` invariant documented above this method.
      let undoErr = null;
      for (let attempt = 0; attempt < UNDO_ATTEMPTS; attempt++) {
        try { tgtDb.prepare('DELETE FROM threads WHERE id = ?').run(params.id); undoErr = null; break; }
        catch (err) { undoErr = err; }
      }
      // Confirm by reading the row back rather than inferring success from a statement
      // that did not throw. Only a positive readback clears this: if the check itself
      // throws we cannot prove the copy is gone, and a duplicate we cannot rule out has
      // to be reported exactly like one we have confirmed.
      let undone = false;
      try { undone = !tgtDb.prepare('SELECT id FROM threads WHERE id = ?').get(params.id); }
      catch { /* unprovable — leave undone false */ }

      if (!undone) {
        // Say so loudly and in the response. Reporting this as a plain failure is the
        // one genuinely misleading outcome: the caller would drop the thread back into
        // the source list and never learn that the target holds a live copy too. Both
        // copies carry valid, distinct session keys, so repairSessionKeyWorkspace()
        // considers neither stale and nothing reconciles them on restart.
        const why = undoErr ? undoErr.message : `still present after ${UNDO_ATTEMPTS} attempts`;
        console.error(`[move] DUPLICATE: thread ${params.id} is live in both "${source}" and "${target}". The source delete failed (${e.message}) and the copy could not be withdrawn (${why}). "${source}" holds the authoritative copy; the one in "${target}" is an unintended duplicate and should be removed once the underlying fault is cleared.`);
        return sendError(res, 500, `Move failed and left a duplicate: thread ${params.id} is now in both "${source}" and "${target}". The copy in "${source}" is authoritative.`);
      }
      throw e;
    }

    // Sidecars that are keyed by workspace have to follow the thread. Uploads do not:
    // they live under uploadsDir/<threadId>, which no workspace name enters.
    // Surfaced in the response: the rename refuses when the workspaces run different
    // agents or the new key is taken, and the thread then starts a fresh transcript.
    // The move still succeeded, so this is a qualification on success rather than a
    // failure, and the caller can say so instead of claiming an unqualified move.
    const sessionMoved = renameGatewaySession(thread.session_key, newSessionKey);
    const fromPath = intelligencePath(this.intelligenceDir, source, params.id);
    if (fs.existsSync(fromPath)) {
      const toPath = intelligencePath(this.intelligenceDir, target, params.id);
      try { fs.mkdirSync(path.dirname(toPath), { recursive: true }); fs.renameSync(fromPath, toPath); }
      catch (err) { console.warn(`[move] intelligence for thread ${params.id} left in "${source}":`, err.message); }
    }

    this.broadcast(JSON.stringify({ type: 'clawchats', event: 'thread-moved', threadId: params.id, fromWorkspace: source, toWorkspace: target, timestamp: Date.now() }));
    send(res, 200, { ok: true, sessionMoved, thread: tgtDb.prepare('SELECT * FROM threads WHERE id = ?').get(params.id) });
  }

  // Why `threadId`'s upload directory must survive this delete, or null if it can go.
  //
  // uploads/ is keyed by thread id alone — uploadsDir/<threadId>, with no workspace
  // segment anywhere in the path — but thread ids are not unique across workspaces:
  // POST /api/import preserves caller-supplied ids, and a move whose source delete
  // fails leaves the same id live in both (see move()). Removing the directory would
  // then destroy the attachments of the copy still live in the other workspace, which
  // keeps its rows and goes on pointing at files that are gone.
  //
  // Called after the source row is deleted, so any row this finds is another
  // workspace's copy. A workspace that cannot be read counts as a reason to keep the
  // directory: it cannot rule the duplicate out, and an orphaned directory is
  // recoverable where a live thread's attachments are not.
  uploadsRetentionReason(threadId) {
    for (const name of Object.keys(this.getWorkspaces().workspaces)) {
      try {
        if (this.getDb(name).prepare('SELECT id FROM threads WHERE id = ?').get(threadId)) {
          return `it is still live in workspace "${name}"`;
        }
      } catch (e) {
        return `workspace "${name}" could not be checked (${e.message})`;
      }
    }
    return null;
  }

  delete(req, res, params) {
    const db = this.getActiveDb();
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(params.id);
    if (!thread) return sendError(res, 404, 'Thread not found');
    db.prepare('DELETE FROM threads WHERE id = ?').run(params.id);
    // cleanGatewaySession() unlinks the transcript the store associates with this
    // thread's key, and the store is the only thing that records that association.
    //
    // This used to consult `thread.last_session_id` first and fall back to the store,
    // which meant the extra unlink only did anything when the two disagreed. That is
    // exactly the exploitable case: that column never had a server-side writer — see
    // update() — so a caller could name any transcript in a store that is resolved per
    // *agent* and shared by every workspace, and deleting its own thread would unlink
    // another workspace's live session (CLA-1503). CLA-1496 stopped the value escaping
    // the store; it could still pick anything inside it. CLA-1509 dropped the column.
    cleanGatewaySession(thread.session_key);
    const retain = this.uploadsRetentionReason(params.id);
    if (retain) console.warn(`[delete] keeping the uploads for thread ${params.id}: ${retain}.`);
    else try { fs.rmSync(path.join(this.uploadsDir, params.id), { recursive: true }); } catch { /* ok */ }
    send(res, 200, { ok: true });
  }
}
