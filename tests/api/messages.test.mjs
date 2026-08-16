// Contract tests for messages, search, and export/import (CLA-1269).
//
// The gateway WebSocket is never connected here. Per server/gateway.js, a send
// with no connection logs and does not throw, so POST /api/threads/:id/messages
// still returns success and still writes to SQLite — that persistence is what
// these tests exercise.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createThread } from '../helpers/harness.mjs';

describe('POST /api/threads/:id/messages', () => {
  let srv, tid;
  before(async () => {
    srv = await startTestServer();
    tid = await createThread(srv.api);
  });
  after(async () => { await srv.close(); });

  test('creates a message and returns 201 with the persisted row', async () => {
    const res = await srv.api('POST', `/api/threads/${tid}/messages`, {
      body: { id: 'm1', role: 'user', content: 'Hello world', timestamp: 100 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.message.id, 'm1');
    assert.equal(res.body.message.thread_id, tid);
    assert.equal(res.body.message.role, 'user');
    assert.equal(res.body.message.content, 'Hello world');
    assert.equal(res.body.message.status, 'sent', 'status defaults to sent');
    assert.equal(res.body.message.timestamp, 100);
    assert.equal(res.body.message.metadata, null);
  });

  test('persists to the database — a fresh GET sees the row', async () => {
    await srv.api('POST', `/api/threads/${tid}/messages`, {
      body: { id: 'm-persist', role: 'assistant', content: 'stored via gateway-less write', timestamp: 150 },
    });
    const list = await srv.api('GET', `/api/threads/${tid}/messages`);
    const found = list.body.messages.find(m => m.id === 'm-persist');
    assert.ok(found, 'message written despite no gateway connection');
    assert.equal(found.content, 'stored via gateway-less write');
  });

  test('rejects a body missing id, role, content, or timestamp', async () => {
    const cases = [
      { role: 'user', content: 'no id', timestamp: 1 },
      { id: 'x1', content: 'no role', timestamp: 1 },
      { id: 'x2', role: 'user', timestamp: 1 },
      { id: 'x3', role: 'user', content: 'no timestamp' },
    ];
    for (const body of cases) {
      const res = await srv.api('POST', `/api/threads/${tid}/messages`, { body });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.match(res.body.error, /Required: id, role, content, timestamp/);
    }
  });

  test('empty-string content is accepted (only undefined is rejected)', async () => {
    const res = await srv.api('POST', `/api/threads/${tid}/messages`, {
      body: { id: 'empty-content', role: 'user', content: '', timestamp: 300 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.message.content, '');
  });

  test('any role string is accepted — no server-side enum check', async () => {
    const res = await srv.api('POST', `/api/threads/${tid}/messages`, {
      body: { id: 'weird-role', role: 'narrator', content: 'anything goes', timestamp: 301 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.message.role, 'narrator');
  });

  test('404s for an unknown thread id', async () => {
    const res = await srv.api('POST', `/api/threads/does-not-exist/messages`, {
      body: { id: 'orphan', role: 'user', content: 'hi', timestamp: 1 },
    });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Thread not found/);
  });

  test('re-posting an existing id updates in place (upsert) and returns 200', async () => {
    await srv.api('POST', `/api/threads/${tid}/messages`, {
      body: { id: 'upsert-1', role: 'user', content: 'original', timestamp: 500 },
    });
    const res = await srv.api('POST', `/api/threads/${tid}/messages`, {
      body: { id: 'upsert-1', role: 'user', content: 'edited', status: 'edited', timestamp: 999 },
    });
    assert.equal(res.status, 200, 'update path returns 200, not 201');
    assert.equal(res.body.message.content, 'edited');
    assert.equal(res.body.message.status, 'edited');
    assert.equal(res.body.message.timestamp, 500, 'UPDATE does not touch timestamp — only status/content/metadata');
  });

  test('the first user message on a fresh thread sets the title from its content', async () => {
    const freshId = await createThread(srv.api);
    const before = await srv.api('GET', `/api/threads/${freshId}`);
    assert.equal(before.body.thread.title, 'New chat');

    await srv.api('POST', `/api/threads/${freshId}/messages`, {
      body: { id: 'title-seed', role: 'user', content: 'x'.repeat(50), timestamp: 1 },
    });
    const after = await srv.api('GET', `/api/threads/${freshId}`);
    assert.equal(after.body.thread.title, 'x'.repeat(40) + '...', 'title truncated to 40 chars with ellipsis');
  });
});

describe('GET /api/threads/:id/messages', () => {
  let srv, tid;
  before(async () => {
    srv = await startTestServer();
    tid = await createThread(srv.api);
    for (let i = 1; i <= 5; i++) {
      await srv.api('POST', `/api/threads/${tid}/messages`, {
        body: { id: `m${i}`, role: i % 2 ? 'user' : 'assistant', content: `msg ${i}`, timestamp: i * 100 },
      });
    }
  });
  after(async () => { await srv.close(); });

  test('returns messages in chronological (ascending timestamp) order', async () => {
    const res = await srv.api('GET', `/api/threads/${tid}/messages`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages.map(m => m.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
    const timestamps = res.body.messages.map(m => m.timestamp);
    const sorted = [...timestamps].sort((a, b) => a - b);
    assert.deepEqual(timestamps, sorted);
  });

  test('limit returns the most recent N messages, still in chronological order', async () => {
    const res = await srv.api('GET', `/api/threads/${tid}/messages?limit=2`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages.map(m => m.id), ['m4', 'm5']);
    assert.equal(res.body.hasMore, true);
  });

  test('hasMore is false when every message fits under the limit', async () => {
    const res = await srv.api('GET', `/api/threads/${tid}/messages?limit=500`);
    assert.equal(res.body.messages.length, 5);
    assert.equal(res.body.hasMore, false);
  });

  test('before filters to messages with an earlier timestamp', async () => {
    const res = await srv.api('GET', `/api/threads/${tid}/messages?before=300`);
    assert.deepEqual(res.body.messages.map(m => m.id), ['m1', 'm2']);
  });

  test('after filters to messages with a later timestamp', async () => {
    const res = await srv.api('GET', `/api/threads/${tid}/messages?after=300`);
    assert.deepEqual(res.body.messages.map(m => m.id), ['m4', 'm5']);
  });

  test('404s for an unknown thread id', async () => {
    const res = await srv.api('GET', `/api/threads/does-not-exist/messages`);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Thread not found/);
  });

  test('an empty thread returns an empty list, not an error', async () => {
    const emptyId = await createThread(srv.api);
    const res = await srv.api('GET', `/api/threads/${emptyId}/messages`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages, []);
    assert.equal(res.body.hasMore, false);
  });
});

describe('DELETE /api/threads/:id/messages/:messageId', () => {
  let srv, tid;
  before(async () => {
    srv = await startTestServer();
    tid = await createThread(srv.api);
    await srv.api('POST', `/api/threads/${tid}/messages`, { body: { id: 'keep', role: 'user', content: 'keep me', timestamp: 1 } });
    await srv.api('POST', `/api/threads/${tid}/messages`, { body: { id: 'doomed', role: 'user', content: 'delete me', timestamp: 2 } });
  });
  after(async () => { await srv.close(); });

  test('404s when the message id does not exist on the thread', async () => {
    const res = await srv.api('DELETE', `/api/threads/${tid}/messages/does-not-exist`);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Message not found/);
  });

  test('404s when the message exists but under a different thread id', async () => {
    const otherThread = await createThread(srv.api);
    const res = await srv.api('DELETE', `/api/threads/${otherThread}/messages/keep`);
    assert.equal(res.status, 404, 'message id must belong to the thread id in the path');
  });

  test('deletes the message and it is gone from a subsequent list', async () => {
    const del = await srv.api('DELETE', `/api/threads/${tid}/messages/doomed`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { ok: true });

    const list = await srv.api('GET', `/api/threads/${tid}/messages`);
    assert.deepEqual(list.body.messages.map(m => m.id), ['keep']);
  });

  test('deleting the same id twice 404s the second time', async () => {
    const res = await srv.api('DELETE', `/api/threads/${tid}/messages/doomed`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/search', () => {
  let srv, tid;
  before(async () => {
    srv = await startTestServer();
    tid = await createThread(srv.api);
    await srv.api('POST', `/api/threads/${tid}/messages`, {
      body: { id: 'sm1', role: 'user', content: 'Hello world, this is a test message about cats.', timestamp: 100 },
    });
    await srv.api('POST', `/api/threads/${tid}/messages`, {
      body: { id: 'sm2', role: 'assistant', content: 'Dogs are great too.', timestamp: 200 },
    });
  });
  after(async () => { await srv.close(); });

  test('finds a match and returns a highlighted snippet', async () => {
    const res = await srv.api('GET', '/api/search?q=cats');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.results.length, 1);
    const [hit] = res.body.results;
    assert.equal(hit.messageId, 'sm1');
    assert.equal(hit.threadId, tid);
    assert.equal(hit.role, 'user');
    assert.match(hit.content, /<mark>cats<\/mark>/);
  });

  test('returns an empty result set for a query with no match', async () => {
    const res = await srv.api('GET', '/api/search?q=nonexistentxyz');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { results: [], total: 0 });
  });

  test('an empty query short-circuits to an empty result set without touching the DB', async () => {
    const res = await srv.api('GET', '/api/search?q=');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { results: [], total: 0 });
  });

  test('a missing q param behaves the same as an empty one', async () => {
    const res = await srv.api('GET', '/api/search');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { results: [], total: 0 });
  });

  test('FTS5 syntax-breaking input does not 500 — invalid queries degrade to empty results', async () => {
    const dangerous = ['"unbalanced', 'cats AND', '*', 'foo OR OR bar', '(((', 'NEAR('];
    for (const q of dangerous) {
      const res = await srv.api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, `query ${JSON.stringify(q)} must not error`);
      assert.deepEqual(res.body, { results: [], total: 0 }, `query ${JSON.stringify(q)} should degrade to empty, not throw`);
    }
  });

  test('a lone apostrophe query does not 500 (quote-injection surface)', async () => {
    const res = await srv.api('GET', `/api/search?q=${encodeURIComponent("o'brien")}`);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.total, 'number');
  });

  test('page and limit paginate results in match-rank order', async () => {
    const tid2 = await createThread(srv.api);
    for (let i = 1; i <= 3; i++) {
      await srv.api('POST', `/api/threads/${tid2}/messages`, {
        body: { id: `banana-${i}`, role: 'user', content: `banana split number ${i}`, timestamp: i * 10 },
      });
    }
    const page1 = await srv.api('GET', '/api/search?q=banana&limit=2&page=1');
    assert.equal(page1.status, 200);
    assert.equal(page1.body.total, 3);
    assert.equal(page1.body.results.length, 2);

    const page2 = await srv.api('GET', '/api/search?q=banana&limit=2&page=2');
    assert.equal(page2.status, 200);
    assert.equal(page2.body.total, 3);
    assert.equal(page2.body.results.length, 1);

    const page1Ids = page1.body.results.map(r => r.messageId);
    const page2Ids = page2.body.results.map(r => r.messageId);
    assert.equal(new Set([...page1Ids, ...page2Ids]).size, 3, 'pages must not overlap');
  });
});

describe('GET /api/export and POST /api/import', () => {
  test('export includes threads with their messages in chronological order', async () => {
    const srv = await startTestServer();
    try {
      const tid = await createThread(srv.api);
      await srv.api('POST', `/api/threads/${tid}/messages`, { body: { id: 'e1', role: 'user', content: 'first', timestamp: 10 } });
      await srv.api('POST', `/api/threads/${tid}/messages`, { body: { id: 'e2', role: 'assistant', content: 'second', timestamp: 20 } });

      const res = await srv.api('GET', '/api/export');
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.exportedAt, 'number');
      assert.equal(res.body.workspace, 'default');
      assert.ok(Array.isArray(res.body.threads));

      const thread = res.body.threads.find(t => t.id === tid);
      assert.ok(thread, 'exported thread present');
      assert.ok(Array.isArray(thread.messages));
      assert.deepEqual(thread.messages.map(m => m.id), ['e1', 'e2'], 'messages exported oldest-first');
    } finally {
      await srv.close();
    }
  });

  test('import rejects a payload without a threads array', async () => {
    const srv = await startTestServer();
    try {
      const res = await srv.api('POST', '/api/import', { body: { foo: 'bar' } });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Expected \{ threads: \[\.\.\.\] \}/);
    } finally {
      await srv.close();
    }
  });

  test('threads/messages missing a required id are silently skipped, not errored', async () => {
    const srv = await startTestServer();
    try {
      const res = await srv.api('POST', '/api/import', {
        body: { threads: [{ title: 'no id, skipped' }, { id: 'valid-thread', messages: [{ role: 'user', content: 'no id, skipped' }] }] },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.threadsImported, 1, 'only the thread with an id counts');
      assert.equal(res.body.messagesImported, 0, 'the message without an id is skipped');
    } finally {
      await srv.close();
    }
  });

  test('round-trips: export from one server, import into another, data is present', async () => {
    const src = await startTestServer();
    const dst = await startTestServer();
    try {
      const tid = await createThread(src.api);
      await src.api('POST', `/api/threads/${tid}/messages`, {
        body: { id: 'rt1', role: 'user', content: 'round trip content', metadata: { foo: 'bar' }, timestamp: 42 },
      });
      const exported = await src.api('GET', '/api/export');
      assert.equal(exported.status, 200);

      const imported = await dst.api('POST', '/api/import', { body: exported.body });
      assert.equal(imported.status, 200);
      assert.equal(imported.body.threadsImported, 1);
      assert.equal(imported.body.messagesImported, 1);

      const list = await dst.api('GET', `/api/threads/${tid}/messages`);
      assert.equal(list.status, 200);
      assert.equal(list.body.messages.length, 1);
      assert.equal(list.body.messages[0].content, 'round trip content');
      assert.deepEqual(list.body.messages[0].metadata, { foo: 'bar' }, 'metadata round-trips as parsed JSON');
    } finally {
      await src.close();
      await dst.close();
    }
  });

  test('importing the same payload twice is idempotent (INSERT OR IGNORE)', async () => {
    const srv = await startTestServer();
    try {
      const payload = { threads: [{ id: 'dup-thread', title: 'Dup', messages: [{ id: 'dup-msg', role: 'user', content: 'once', timestamp: 5 }] }] };
      const first = await srv.api('POST', '/api/import', { body: payload });
      assert.equal(first.body.threadsImported, 1);
      assert.equal(first.body.messagesImported, 1);

      const second = await srv.api('POST', '/api/import', { body: payload });
      assert.equal(second.body.threadsImported, 0, 'existing thread id is ignored, not duplicated');
      assert.equal(second.body.messagesImported, 0, 'existing message id is ignored, not duplicated');

      const list = await srv.api('GET', `/api/threads/dup-thread/messages`);
      assert.equal(list.body.messages.length, 1, 'no duplicate rows created');
    } finally {
      await srv.close();
    }
  });
});
