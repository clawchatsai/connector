// Contract tests for getRequestWorkspace() at the remaining call sites (CLA-1279).
//
// Every request may target a workspace other than the process-global active one
// via the x-workspace header. These sites used to read getWorkspaces().active, so
// they named — or filed data under — the wrong workspace whenever the two
// differed. In each test the active workspace stays "default" and the request
// targets "second"; the assertion is that "default" never appears.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startTestServer, createThread } from '../helpers/harness.mjs';

const TARGET = { 'x-workspace': 'second' };

describe('request workspace identity', () => {
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
    const created = await srv.api('POST', '/api/workspaces', { body: { name: 'second' } });
    assert.equal(created.status, 201, 'workspace setup');
    const list = await srv.api('GET', '/api/workspaces');
    assert.equal(list.body.active, 'default', 'the active workspace must differ from the targeted one');
  });
  after(async () => { await srv.close(); });

  beforeEach(() => { broadcasts = captureBroadcasts(); });

  test('mark-read announces the targeted workspace, not the active one', async () => {
    const id = await createThread(srv.api, {});
    const res = await srv.api('POST', `/api/threads/${id}/mark-read`, {
      headers: TARGET,
      body: { messageIds: ['m1'] },
    });
    assert.equal(res.status, 200);

    const event = broadcasts.find(m => m.event === 'unread-update' && m.threadId === id);
    assert.ok(event, 'mark-read broadcasts unread-update');
    // app.js compares this field against its own activeWorkspace to decide which
    // badge to clear, so "default" here clears the wrong workspace's badge.
    assert.equal(event.workspace, 'second');
  });

  test('the first-message title broadcast names the targeted workspace', async () => {
    const created = await srv.api('POST', '/api/threads', { headers: TARGET });
    const id = created.body.thread.id;
    assert.equal(created.body.thread.title, 'New chat', 'title auto-fill only fires from "New chat"');

    const res = await srv.api('POST', `/api/threads/${id}/messages`, {
      headers: TARGET,
      body: { id: 'msg-title', role: 'user', content: 'Hello from second', timestamp: Date.now() },
    });
    assert.equal(res.status, 201);

    const event = broadcasts.find(m => m.event === 'thread-title-updated' && m.threadId === id);
    assert.ok(event, 'the first user message broadcasts thread-title-updated');
    assert.equal(event.workspace, 'second');
  });

  test('generate-title attributes the thread to the targeted workspace', async () => {
    // handleTitleResponse() resolves the database to write the AI title into from
    // the workspace captured here, so a wrong value misroutes a later write. With
    // a single message the heuristic broadcast fires and the gateway is never
    // dialled, which is what makes this observable without a gateway.
    const created = await srv.api('POST', '/api/threads', { headers: TARGET });
    const id = created.body.thread.id;
    await srv.api('POST', `/api/threads/${id}/messages`, {
      headers: TARGET,
      body: { id: 'msg-gen', role: 'user', content: 'Generate me a title', timestamp: Date.now() },
    });

    const res = await srv.api('POST', `/api/threads/${id}/generate-title`, { headers: TARGET });
    assert.equal(res.status, 200);

    const events = broadcasts.filter(m => m.event === 'thread-title-updated' && m.threadId === id);
    assert.ok(events.length >= 2, 'generate-title re-broadcasts the heuristic title');
    for (const event of events) assert.equal(event.workspace, 'second');
  });

  test('export labels the dump with the workspace it dumped', async () => {
    const res = await srv.api('GET', '/api/export', { headers: TARGET });
    assert.equal(res.status, 200);
    // import() mints session keys for keyless threads from the targeted workspace,
    // so a dump labelled "default" round-trips into keys naming the wrong one.
    assert.equal(res.body.workspace, 'second');
  });

  test('intelligence is filed under the targeted workspace and readable back', async () => {
    const id = await createThread(srv.api, {});
    const payload = { versions: [{ content: 'notes for second' }], currentVersion: 0 };

    const saved = await srv.api('POST', `/api/threads/${id}/intelligence`, { headers: TARGET, body: payload });
    assert.equal(saved.status, 200);

    const onDisk = path.join(srv.dataDir, 'intelligence', 'second', `${id}.json`);
    assert.ok(fs.existsSync(onDisk), `intelligence must be written to ${onDisk}`);
    assert.ok(!fs.existsSync(path.join(srv.dataDir, 'intelligence', 'default', `${id}.json`)),
      'nothing may be written under the active workspace');

    const read = await srv.api('GET', `/api/threads/${id}/intelligence`, { headers: TARGET });
    assert.deepEqual(read.body.versions, payload.versions, 'the same request workspace reads it back');

    // Another workspace's request must not see it — the path is the isolation.
    const other = await srv.api('GET', `/api/threads/${id}/intelligence`);
    assert.deepEqual(other.body.versions, [], 'intelligence does not leak across workspaces');
  });
});
