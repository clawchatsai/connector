// Contract tests for POST /api/threads/:id/move (CLA-1383).
//
// The endpoint carries a thread, its messages and its unread bookkeeping from one
// workspace database into another, then announces `thread-moved` so other tabs drop
// or pick up the thread. Two things make it worth this much coverage: the two halves
// live in different SQLite files, so "atomic" has to be built rather than declared,
// and the thread trails three workspace-scoped sidecars (session key, gateway
// session, intelligence artefact) that are silently lost if left behind.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startTestServer, createThread } from '../helpers/harness.mjs';
import { sandboxSessionsDir } from '../helpers/sandbox-home.mjs';

const SECOND = { 'x-workspace': 'second' };

/** Insert a message straight into `db`, as the FTS triggers see it. */
function seedMessage(db, threadId, id, content, role = 'user') {
  const now = Date.now();
  db.prepare(
    'INSERT INTO messages (id, thread_id, role, content, status, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, threadId, role, content, 'sent', now, now);
}

describe('POST /api/threads/:id/move', () => {
  let srv;
  let broadcasts;

  /** Collect every frame the server pushes to browsers during one test. */
  function captureBroadcasts() {
    const seen = [];
    srv.app.gatewayClient.addBroadcastTarget(data => {
      try { seen.push(JSON.parse(data)); } catch { /* non-JSON frame */ }
    });
    return seen;
  }

  before(async () => {
    srv = await startTestServer();
    for (const name of ['second', 'third']) {
      const created = await srv.api('POST', '/api/workspaces', { body: { name } });
      assert.equal(created.status, 201, `workspace setup: ${name}`);
    }
    const list = await srv.api('GET', '/api/workspaces');
    assert.equal(list.body.active, 'default', 'the active workspace must stay "default"');
  });
  after(async () => { await srv.close(); });

  beforeEach(() => { broadcasts = captureBroadcasts(); });

  describe('rejections', () => {
    test('a missing workspace key is a 400, not a 500', async () => {
      const id = await createThread(srv.api);
      const res = await srv.api('POST', `/api/threads/${id}/move`, { body: {} });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /workspace is required/i);
      assert.ok(srv.app.getActiveDb().prepare('SELECT id FROM threads WHERE id = ?').get(id), 'thread stays put');
    });

    test('an unregistered target is a 404 and does not mint a database for it', async () => {
      const id = await createThread(srv.api);
      const res = await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'ghost' } });
      assert.equal(res.status, 404);
      assert.match(res.body.error, /target workspace not found/i);
      // getDb() creates the file it cannot open, so an unguarded target would leave a
      // ghost.db behind that GET /api/workspaces never lists — CLA-1331.
      assert.equal(fs.existsSync(path.join(srv.dataDir, 'ghost.db')), false);
    });

    test('a prototype key like "constructor" is treated as unregistered', async () => {
      const id = await createThread(srv.api);
      const res = await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'constructor' } });
      assert.equal(res.status, 404);
      // Assert the reason, not just the code: an unrouted request 404s too, which
      // would let this pass against a build that has no move endpoint at all.
      assert.match(res.body.error, /target workspace not found/i);
    });

    test('moving into the workspace the thread is already in is a 400', async () => {
      const id = await createThread(srv.api);
      const res = await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'default' } });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /already in this workspace/i);
    });

    test('same-workspace is judged against the targeted workspace, not the active one', async () => {
      // Active is "default" throughout. A handler reading getWorkspaces().active would
      // wave this through and then move a "second" thread onto itself.
      const id = await createThread(srv.api, {});
      await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'second' } });
      const res = await srv.api('POST', `/api/threads/${id}/move`, { headers: SECOND, body: { workspace: 'second' } });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /already in this workspace/i);
    });

    test('an unknown thread is a 404', async () => {
      const res = await srv.api('POST', '/api/threads/no-such-thread/move', { body: { workspace: 'second' } });
      assert.equal(res.status, 404);
      assert.match(res.body.error, /thread not found/i);
    });

    test('a colliding id in the target is a 409 and leaves both sides intact', async () => {
      // Thread ids are only unique per workspace: POST /api/import preserves
      // caller-supplied ids, so the same id in two workspaces is reachable.
      const id = 'collision-id';
      await srv.api('POST', '/api/threads', { body: { id } });
      await srv.api('POST', '/api/threads', { headers: SECOND, body: { id } });
      const srcDb = srv.app.getDb('default');
      seedMessage(srcDb, id, 'src-msg', 'from the source');

      const res = await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'second' } });
      assert.equal(res.status, 409);
      // Assert the explicit pre-check's wording. Dropping the guard still yields 409 —
      // the INSERT trips threads.id and route() maps "UNIQUE constraint" to Conflict —
      // so a status-only assertion cannot tell the two apart.
      assert.match(res.body.error, /already exists in the target workspace/i);

      assert.ok(srcDb.prepare('SELECT id FROM threads WHERE id = ?').get(id), 'source thread survives');
      assert.equal(srcDb.prepare('SELECT COUNT(*) c FROM messages WHERE thread_id = ?').get(id).c, 1);
      // The target's own thread must not have been overwritten or gained the messages.
      const tgtDb = srv.app.getDb('second');
      assert.equal(tgtDb.prepare('SELECT COUNT(*) c FROM messages WHERE thread_id = ?').get(id).c, 0);
      assert.equal(tgtDb.prepare('SELECT session_key FROM threads WHERE id = ?').get(id).session_key, `agent:main:second:chat:${id}`);
    });
  });

  describe('the move itself', () => {
    test('carries the thread, its messages and its unread rows, and empties the source', async () => {
      const id = await createThread(srv.api);
      const srcDb = srv.app.getDb('default');
      seedMessage(srcDb, id, 'm1', 'first message');
      seedMessage(srcDb, id, 'm2', 'second message', 'assistant');
      srcDb.prepare('INSERT INTO unread_messages (thread_id, message_id, created_at) VALUES (?, ?, ?)').run(id, 'm2', Date.now());
      srcDb.prepare('UPDATE threads SET title = ?, pinned = 1, sort_order = 7, unread_count = 1 WHERE id = ?').run('Carried over', id);

      const res = await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'second' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      assert.equal(srcDb.prepare('SELECT id FROM threads WHERE id = ?').get(id), undefined, 'source thread removed');
      assert.equal(srcDb.prepare('SELECT COUNT(*) c FROM messages WHERE thread_id = ?').get(id).c, 0, 'source messages removed');
      assert.equal(srcDb.prepare('SELECT COUNT(*) c FROM unread_messages WHERE thread_id = ?').get(id).c, 0, 'source unread rows removed');

      const tgtDb = srv.app.getDb('second');
      const moved = tgtDb.prepare('SELECT * FROM threads WHERE id = ?').get(id);
      assert.ok(moved, 'thread landed in the target');
      // Every column travels, not just the ones a hand-written list remembered.
      assert.equal(moved.title, 'Carried over');
      assert.equal(moved.pinned, 1);
      assert.equal(moved.sort_order, 7);
      assert.equal(moved.unread_count, 1);
      // node:sqlite hands back null-prototype rows; spread them so deep-equal compares
      // values rather than prototypes.
      assert.deepEqual(
        tgtDb.prepare('SELECT id, role, content FROM messages WHERE thread_id = ? ORDER BY id').all(id).map(r => ({ ...r })),
        [{ id: 'm1', role: 'user', content: 'first message' }, { id: 'm2', role: 'assistant', content: 'second message' }],
      );
      // Without these the target shows an unread badge that GET /api/threads/unread
      // cannot explain and mark-read cannot clear.
      assert.deepEqual(tgtDb.prepare('SELECT message_id FROM unread_messages WHERE thread_id = ?').all(id).map(r => ({ ...r })), [{ message_id: 'm2' }]);
      assert.deepEqual(res.body.thread, { ...moved }, 'the response body is the row as it landed');
    });

    test('re-keys session_key to the target workspace and its agent', async () => {
      const id = await createThread(srv.api);
      const res = await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'second' } });
      assert.equal(res.status, 200);
      // parseSessionKey() routes every gateway event by this field, so a stale
      // workspace segment sends the moved thread's replies to the workspace it left.
      assert.equal(res.body.thread.session_key, `agent:main:second:chat:${id}`);
    });

    test('announces thread-moved with both endpoints of the move', async () => {
      const id = await createThread(srv.api);
      await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'second' } });

      const event = broadcasts.find(m => m.event === 'thread-moved' && m.threadId === id);
      assert.ok(event, 'a thread-moved frame is broadcast');
      assert.equal(event.type, 'clawchats');
      // app.js keys off exactly these two: fromWorkspace drops the thread from the
      // list, toWorkspace triggers a reload.
      assert.equal(event.fromWorkspace, 'default');
      assert.equal(event.toWorkspace, 'second');
    });

    test('moves out of the targeted workspace, not the active one', async () => {
      // Active stays "default". This thread lives in "second" and must land in "third"
      // without "default" being read from or written to.
      const id = await createThread(srv.api, {});
      await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'second' } });

      const res = await srv.api('POST', `/api/threads/${id}/move`, { headers: SECOND, body: { workspace: 'third' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.thread.session_key, `agent:main:third:chat:${id}`);
      assert.equal(srv.app.getDb('second').prepare('SELECT id FROM threads WHERE id = ?').get(id), undefined);
      assert.ok(srv.app.getDb('third').prepare('SELECT id FROM threads WHERE id = ?').get(id));

      const event = broadcasts.find(m => m.event === 'thread-moved' && m.threadId === id && m.toWorkspace === 'third');
      assert.equal(event.fromWorkspace, 'second');
    });

    test('the full-text index follows the messages', async () => {
      const id = await createThread(srv.api);
      seedMessage(srv.app.getDb('default'), id, 'fts-msg', 'zanzibar pineapple');

      const before = await srv.api('GET', '/api/search?q=zanzibar');
      assert.equal(before.body.total, 1, 'indexed in the source to begin with');

      await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'second' } });

      // Pins behaviour the move gets for free but silently depends on: deleting the
      // thread cascades to messages, and that cascade fires the messages_ad trigger, so
      // the source FTS index drops the text too. Verified against SQLite 3.51.2 with
      // recursive_triggers both on and off. A migrate() change that swapped the cascade
      // for a manual delete, or dropped the trigger, would leave the moved text
      // searchable in the workspace it left — with no other test noticing.
      const after = await srv.api('GET', '/api/search?q=zanzibar');
      assert.equal(after.body.total, 0, 'no longer searchable in the source');
      const target = await srv.api('GET', '/api/search?q=zanzibar', { headers: SECOND });
      assert.equal(target.body.total, 1, 'searchable in the target');
      assert.equal(target.body.results[0].threadId, id);
    });
  });

  describe('workspace-scoped sidecars', () => {
    test('the gateway session entry is re-pointed at the new key', async () => {
      const id = await createThread(srv.api);
      const sessionsDir = sandboxSessionsDir('main');
      const sessionsPath = path.join(sessionsDir, 'sessions.json');
      fs.writeFileSync(sessionsPath, JSON.stringify({ [`agent:main:default:chat:${id}`]: { sessionId: 'sess-1' } }));

      await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'second' } });

      // Left behind, the moved thread would silently start a fresh gateway session and
      // lose the conversation the user can still see in the transcript.
      const store = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      assert.deepEqual(store, { [`agent:main:second:chat:${id}`]: { sessionId: 'sess-1' } });
    });

    test('an occupied target key is left alone rather than overwritten', async () => {
      const id = await createThread(srv.api);
      const sessionsPath = path.join(sandboxSessionsDir('main'), 'sessions.json');
      const oldKey = `agent:main:default:chat:${id}`;
      const newKey = `agent:main:second:chat:${id}`;
      // Reachable via export/import, which preserves thread ids across workspaces.
      fs.writeFileSync(sessionsPath, JSON.stringify({ [oldKey]: { sessionId: 'mine' }, [newKey]: { sessionId: 'someone-elses' } }));

      const res = await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'second' } });
      assert.equal(res.status, 200, 'the move still succeeds; the session is auxiliary');

      const store = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      assert.equal(store[newKey].sessionId, 'someone-elses', 'the live transcript under the new key survives');
      assert.equal(store[oldKey].sessionId, 'mine', 'and the old entry is left inert rather than deleted');
    });

    test('the intelligence artefact follows the thread', async () => {
      const id = await createThread(srv.api);
      const saved = await srv.api('POST', `/api/threads/${id}/intelligence`, { body: { versions: [{ note: 'keep me' }], currentVersion: 0 } });
      assert.equal(saved.status, 200);

      await srv.api('POST', `/api/threads/${id}/move`, { body: { workspace: 'second' } });

      // The path is workspace-scoped, so leaving the file behind empties the panel for
      // a thread whose messages moved perfectly well.
      const read = await srv.api('GET', `/api/threads/${id}/intelligence`, { headers: SECOND });
      assert.deepEqual(read.body.versions, [{ note: 'keep me' }]);
      assert.equal(fs.existsSync(path.join(srv.dataDir, 'intelligence', 'default', `${id}.json`)), false, 'not left in the source workspace');
    });
  });
});
