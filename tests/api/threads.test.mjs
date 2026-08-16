// Contract tests for the threads endpoints (CLA-1269).
//
// Covers POST/GET/PATCH/DELETE /api/threads[/:id], mark-read/unread
// bookkeeping, and the route-ordering trap where `GET /api/threads/unread`
// must not be swallowed by `GET /api/threads/:id`.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createThread } from '../helpers/harness.mjs';
import { syncThreadUnreadCount } from '../../server/util/helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('POST /api/threads (create)', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('creates a thread with generated id, default title, and session_key format', async () => {
    const res = await srv.api('POST', '/api/threads', { body: {} });
    assert.equal(res.status, 201);
    const { thread } = res.body;
    assert.match(thread.id, UUID_RE, 'id should be a generated uuid when none supplied');
    assert.equal(thread.title, 'New chat');
    assert.equal(thread.session_key, `agent:main:default:chat:${thread.id}`);
    assert.equal(thread.pinned, 0);
    assert.equal(thread.pin_order, 0);
    assert.equal(thread.sort_order, 0);
    assert.equal(thread.unread_count, 0);
    assert.equal(typeof thread.created_at, 'number');
    assert.equal(thread.created_at, thread.updated_at);
  });

  test('honors a caller-supplied id', async () => {
    const res = await srv.api('POST', '/api/threads', { body: { id: 'custom-thread-id' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.thread.id, 'custom-thread-id');
    assert.equal(res.body.thread.session_key, 'agent:main:default:chat:custom-thread-id');
  });

  test('a supplied title is not honored — thread is always created as "New chat"', async () => {
    // NOTE: this looks surprising but matches the lazy-creation model described in
    // specs/backend-session-architecture.md — threads start titleless and are
    // auto-titled from the first user message (see MessageController.create).
    // Reported to the requester as worth a second look; asserting current behavior.
    const res = await srv.api('POST', '/api/threads', { body: { id: 'titled-thread', title: 'My Custom Title' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.thread.title, 'New chat');
  });

  test('duplicate id yields 409 Conflict', async () => {
    const id = await createThread(srv.api);
    const dupe = await srv.api('POST', '/api/threads', { body: { id } });
    assert.equal(dupe.status, 409);
    assert.match(dupe.body.error, /already exists/i);
  });

  test('malformed JSON body is rejected, not treated as empty', async () => {
    const res = await srv.api('POST', '/api/threads', {
      raw: true,
      body: '{not valid json',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /invalid json/i);
  });
});

describe('GET /api/threads (list)', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('empty workspace returns an empty list, not an error', async () => {
    const res = await srv.api('GET', '/api/threads');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { threads: [], total: 0, page: 1 });
  });

  test('lists newly created threads with a has_pending flag', async () => {
    const id = await createThread(srv.api);
    const res = await srv.api('GET', '/api/threads');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.threads.length, 1);
    assert.equal(res.body.threads[0].id, id);
    assert.equal(res.body.threads[0].has_pending, 0);
  });

  test('search matches thread content via FTS and returns only matching threads', async () => {
    const matching = await createThread(srv.api);
    const other = await createThread(srv.api);
    await srv.api('POST', `/api/threads/${matching}/messages`, {
      body: { id: 'm1', role: 'user', content: 'a message about giraffes', timestamp: Date.now() },
    });
    await srv.api('POST', `/api/threads/${other}/messages`, {
      body: { id: 'm2', role: 'user', content: 'a message about elephants', timestamp: Date.now() },
    });

    const res = await srv.api('GET', '/api/threads?search=giraffes');
    assert.equal(res.status, 200);
    assert.equal(res.body.threads.length, 1);
    assert.equal(res.body.threads[0].id, matching);
  });

  test('an unparsable FTS search query degrades to an empty result, not a 500', async () => {
    // Unbalanced quote is invalid FTS5 MATCH syntax; the handler catches and
    // returns an empty page rather than surfacing the SQLite error.
    const res = await srv.api('GET', `/api/threads?${new URLSearchParams({ search: '"unterminated' })}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { threads: [], total: 0, page: 1 });
  });
});

describe('GET /api/threads (list) - ordering', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('orders pinned first, then by sort_order desc, then updated_at desc', async () => {
    const a = await createThread(srv.api);
    const b = await createThread(srv.api);
    const c = await createThread(srv.api);
    // c: unpinned, highest sort_order -> should sort before b (also unpinned, lower sort_order)
    await srv.api('PATCH', `/api/threads/${c}`, { body: { sort_order: 5 } });
    // a: pinned -> should sort first regardless of sort_order
    await srv.api('PATCH', `/api/threads/${a}`, { body: { pinned: true } });

    const res = await srv.api('GET', '/api/threads');
    assert.equal(res.status, 200);
    const ids = res.body.threads.map(t => t.id);
    assert.deepEqual(ids, [a, c, b]);
    assert.equal(res.body.threads[0].pinned, 1);
  });
});

describe('GET /api/threads (list) - sort_order dominates the updated_at bump', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('posting a message to a lower-sort_order thread does not move it up', async () => {
    const high = await createThread(srv.api);
    const low = await createThread(srv.api);
    await srv.api('PATCH', `/api/threads/${high}`, { body: { sort_order: 5 } });
    await srv.api('PATCH', `/api/threads/${low}`, { body: { sort_order: 1 } });

    const before = await srv.api('GET', '/api/threads');
    assert.deepEqual(before.body.threads.map(t => t.id), [high, low], 'baseline order');

    // updated_at is Date.now() at millisecond resolution, so without a gap the
    // two threads can tie and the ordering claim below becomes ambiguous.
    await new Promise(resolve => setTimeout(resolve, 2));

    // messages.create() requires id, role, content and timestamp and answers 400
    // otherwise. Asserting the status is what stops this test degrading into a
    // vacuous one: a silently rejected post bumps nothing and the final
    // assertion then holds for the wrong reason.
    const posted = await srv.api('POST', `/api/threads/${low}/messages`, {
      body: { id: 'msg-bump-1', role: 'user', content: 'bump me', timestamp: Date.now() },
    });
    assert.equal(posted.status, 201, `message post must succeed: ${JSON.stringify(posted.body)}`);

    // Prove the bump actually landed, so `updated_at DESC` alone would rank the
    // low-sort_order thread first — that is the pressure this test applies.
    const [lowRow, highRow] = await Promise.all([
      srv.api('GET', `/api/threads/${low}`),
      srv.api('GET', `/api/threads/${high}`),
    ]);
    assert.ok(lowRow.body.thread.updated_at > highRow.body.thread.updated_at,
      'the insert must bump threads.updated_at past the other thread');

    const after = await srv.api('GET', '/api/threads');
    assert.deepEqual(after.body.threads.map(t => t.id), [high, low],
      'sort_order outranks the fresher updated_at');
  });
});

describe('GET /api/threads (list) - pagination', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('paginates via page/limit query params', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await createThread(srv.api));
    const page1 = await srv.api('GET', '/api/threads?limit=2&page=1');
    const page2 = await srv.api('GET', '/api/threads?limit=2&page=2');
    assert.equal(page1.status, 200);
    assert.equal(page1.body.total, 3);
    assert.equal(page1.body.threads.length, 2);
    assert.equal(page2.body.threads.length, 1);
    assert.equal(page2.body.page, 2);
    // No overlap between pages.
    const seen = new Set(page1.body.threads.map(t => t.id));
    for (const t of page2.body.threads) assert.equal(seen.has(t.id), false);
  });
});

describe('GET /api/threads/:id', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('fetches a single thread', async () => {
    const id = await createThread(srv.api);
    const res = await srv.api('GET', `/api/threads/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.thread.id, id);
  });

  test('404 for an unknown id', async () => {
    const res = await srv.api('GET', '/api/threads/does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found/i);
  });
});

describe('PATCH /api/threads/:id', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('updates the title and bumps updated_at, leaving other fields intact', async () => {
    const id = await createThread(srv.api);
    const before = (await srv.api('GET', `/api/threads/${id}`)).body.thread;
    await new Promise(r => setTimeout(r, 5)); // ensure a distinguishable timestamp
    const res = await srv.api('PATCH', `/api/threads/${id}`, { body: { title: 'Renamed' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.thread.title, 'Renamed');
    assert.equal(res.body.thread.session_key, before.session_key);
    assert.equal(res.body.thread.created_at, before.created_at);
    assert.ok(res.body.thread.updated_at >= before.updated_at);
  });

  test('partial update of one field does not disturb sibling fields', async () => {
    const id = await createThread(srv.api);
    await srv.api('PATCH', `/api/threads/${id}`, { body: { model: 'claude-x' } });
    const res = await srv.api('PATCH', `/api/threads/${id}`, { body: { pinned: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.thread.pinned, 1);
    assert.equal(res.body.thread.model, 'claude-x', 'earlier PATCH to model must survive a later unrelated PATCH');
  });

  test('metadata accepts an object and is stored as a JSON string', async () => {
    const id = await createThread(srv.api);
    const res = await srv.api('PATCH', `/api/threads/${id}`, { body: { metadata: { foo: 'bar' } } });
    assert.equal(res.status, 200);
    assert.equal(res.body.thread.metadata, JSON.stringify({ foo: 'bar' }));
  });

  test('an empty body is a no-op that still returns the current thread', async () => {
    const id = await createThread(srv.api);
    const before = (await srv.api('GET', `/api/threads/${id}`)).body.thread;
    const res = await srv.api('PATCH', `/api/threads/${id}`, { body: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.thread, before);
  });

  test('404 for an unknown id', async () => {
    const res = await srv.api('PATCH', '/api/threads/does-not-exist', { body: { title: 'x' } });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/threads/:id', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('404 for an unknown id', async () => {
    const res = await srv.api('DELETE', '/api/threads/does-not-exist');
    assert.equal(res.status, 404);
  });

  test('deletes the thread and it no longer appears in the list', async () => {
    const id = await createThread(srv.api);
    const res = await srv.api('DELETE', `/api/threads/${id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });

    const get = await srv.api('GET', `/api/threads/${id}`);
    assert.equal(get.status, 404);
    const list = await srv.api('GET', '/api/threads');
    assert.equal(list.body.threads.some(t => t.id === id), false);
  });

  test('cascades to delete the thread\'s messages', async () => {
    const id = await createThread(srv.api);
    await srv.api('POST', `/api/threads/${id}/messages`, {
      body: { id: 'msg-cascade-1', role: 'user', content: 'hello', timestamp: Date.now() },
    });
    const db = srv.app.getActiveDb();
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM messages WHERE thread_id = ?').get(id).c, 1);

    await srv.api('DELETE', `/api/threads/${id}`);

    assert.equal(db.prepare('SELECT COUNT(*) as c FROM messages WHERE thread_id = ?').get(id).c, 0);
    assert.equal(db.prepare('SELECT id FROM threads WHERE id = ?').get(id), undefined);
  });
});

describe('POST /api/threads/:id/mark-read', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('requires a non-empty messageIds array', async () => {
    const id = await createThread(srv.api);
    const missing = await srv.api('POST', `/api/threads/${id}/mark-read`, { body: {} });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /messageIds/);

    const empty = await srv.api('POST', `/api/threads/${id}/mark-read`, { body: { messageIds: [] } });
    assert.equal(empty.status, 400);

    const wrongType = await srv.api('POST', `/api/threads/${id}/mark-read`, { body: { messageIds: 'm1' } });
    assert.equal(wrongType.status, 400);
  });

  test('clears unread rows for the given message ids and reports the remaining count', async () => {
    const id = await createThread(srv.api);
    const db = srv.app.getActiveDb();
    const now = Date.now();
    db.prepare('INSERT INTO unread_messages (thread_id, message_id, created_at) VALUES (?, ?, ?)').run(id, 'm1', now);
    db.prepare('INSERT INTO unread_messages (thread_id, message_id, created_at) VALUES (?, ?, ?)').run(id, 'm2', now);
    syncThreadUnreadCount(db, id);
    assert.equal(db.prepare('SELECT unread_count FROM threads WHERE id = ?').get(id).unread_count, 2);

    const res = await srv.api('POST', `/api/threads/${id}/mark-read`, { body: { messageIds: ['m1'] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.unread_count, 1);
    assert.equal(db.prepare('SELECT unread_count FROM threads WHERE id = ?').get(id).unread_count, 1);
    assert.equal(db.prepare('SELECT 1 FROM unread_messages WHERE thread_id = ? AND message_id = ?').get(id, 'm1'), undefined);
    assert.ok(db.prepare('SELECT 1 FROM unread_messages WHERE thread_id = ? AND message_id = ?').get(id, 'm2'));
  });

  test('an unknown thread id does not 404 — it is a silent no-op (0 rows affected)', async () => {
    // markRead never checks the thread exists before its DELETE/UPDATE; both are
    // no-ops against zero rows, so the route answers 200 for a nonexistent id.
    // Reported as a possible inconsistency (every other :id route 404s); asserting
    // the actual, currently-shipped behavior here.
    const res = await srv.api('POST', '/api/threads/does-not-exist/mark-read', { body: { messageIds: ['m1'] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.unread_count, 0);
  });
});

describe('GET /api/threads/unread', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('route ordering: /api/threads/unread is not swallowed by GET /api/threads/:id', async () => {
    // If matchRoute for :id were checked first, "unread" would be treated as a
    // thread id and this would come back 404 { error: 'Thread not found' }.
    const res = await srv.api('GET', '/api/threads/unread');
    assert.equal(res.status, 200);
    assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'threads'), 'expected the unread-list shape, not a single thread/404');
    assert.equal(Array.isArray(res.body.threads), true);
  });

  test('empty when no thread has unread messages', async () => {
    await createThread(srv.api);
    const res = await srv.api('GET', '/api/threads/unread');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { threads: [] });
  });

  test('lists threads with unread messages, including lastMessage and unreadMessageIds', async () => {
    const id = await createThread(srv.api);
    const db = srv.app.getActiveDb();
    const now = Date.now();
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, status, timestamp, created_at) VALUES (?, ?, 'assistant', ?, 'sent', ?, ?)"
    ).run('m1', id, 'hello there', now, now);
    db.prepare('INSERT INTO unread_messages (thread_id, message_id, created_at) VALUES (?, ?, ?)').run(id, 'm1', now);
    syncThreadUnreadCount(db, id);

    const res = await srv.api('GET', '/api/threads/unread');
    assert.equal(res.status, 200);
    assert.equal(res.body.threads.length, 1);
    const t = res.body.threads[0];
    assert.equal(t.id, id);
    assert.equal(t.unread_count, 1);
    assert.equal(t.lastMessage, 'hello there');
    assert.deepEqual(t.unreadMessageIds, ['m1']);
  });
});
