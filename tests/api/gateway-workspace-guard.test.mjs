// Contract tests for the registered-workspace guard on gateway-driven storage (CLA-1331).
//
// getDb() creates the file it cannot open. workspaces.json is the register of what
// exists, and both API routes that reach it iterate the register: GET /api/workspaces
// never lists an unregistered name, and DELETE /api/workspaces/:name 404s on one. So a
// gateway event naming a workspace nobody registered does not just write to the wrong
// place — it mints data/<name>.db, storage with no owner and no route to delete it.
//
// Session keys arrive from the gateway, which is not the register's writer, and a run
// outlives the workspace it started in: DELETE unlinks the database file, then the
// in-flight run's abort / activity / title events arrive and put it back.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startTestServer } from '../helpers/harness.mjs';

const raw = JSON.stringify({ type: 'event', event: 'chat' });

function dbFiles(srv) {
  return fs.readdirSync(srv.dataDir).filter(f => f.endsWith('.db')).sort();
}

function dbExists(srv, name) {
  return fs.existsSync(path.join(srv.dataDir, `${name}.db`));
}

/** Register a workspace holding one thread, then delete it — the mid-run race, exactly. */
async function seedThenDelete(srv, workspace, threadId) {
  const created = await srv.api('POST', '/api/workspaces', { body: { name: workspace } });
  assert.equal(created.status, 201, `workspace setup for ${workspace}`);
  const thread = await srv.api('POST', '/api/threads', { headers: { 'x-workspace': workspace }, body: { id: threadId } });
  assert.equal(thread.status, 201, `thread setup for ${workspace}/${threadId}`);

  const deleted = await srv.api('DELETE', `/api/workspaces/${workspace}`);
  assert.equal(deleted.status, 200, `workspace teardown for ${workspace}`);
  assert.equal(dbExists(srv, workspace), false, 'precondition: DELETE unlinked the database file');
}

describe('gateway events never mint a database for an unregistered workspace', () => {
  let srv;

  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('an abort for a workspace deleted mid-run does not recreate its database', async () => {
    await seedThenDelete(srv, 'ghost-abort', 't1');

    srv.app.gatewayClient.handleChatEvent({ sessionKey: 'agent:main:ghost-abort:chat:t1', state: 'aborted' }, raw);

    assert.equal(dbExists(srv, 'ghost-abort'), false,
      'the aborted branch reached getDb() without checking the register');
  });

  test('an activity event for a workspace deleted mid-run does not recreate its database', async () => {
    await seedThenDelete(srv, 'ghost-activity', 't1');

    srv.app.gatewayClient.handleAgentEvent({
      runId: 'run-activity', stream: 'thinking', data: { text: 'still working' },
      sessionKey: 'agent:main:ghost-activity:chat:t1',
    });

    assert.equal(dbExists(srv, 'ghost-activity'), false,
      'writeActivityToDb was handed the raw getDb, which mints on open');
  });

  test('the stale-activity-log sweeper does not recreate a deleted workspace database', async () => {
    await seedThenDelete(srv, 'ghost-sweep', 't1');

    // The sweeper runs on a 5-minute interval over entries older than 10 minutes, so
    // drive one pass directly rather than wait. startTime 0 is comfortably past cutoff.
    srv.app.gatewayClient.activityLogs.set('run-sweep', {
      sessionKey: 'agent:main:ghost-sweep:chat:t1', steps: [], startTime: 0,
      _messageId: 'gw-activity-run-sweep',
      _parsed: { agent: 'main', workspace: 'ghost-sweep', threadId: 't1' },
    });
    srv.app.gatewayClient._sweepStaleActivityLogs();

    assert.equal(dbExists(srv, 'ghost-sweep'), false, 'the sweeper reached getDb() unguarded');
    assert.equal(srv.app.gatewayClient.activityLogs.has('run-sweep'), false,
      'the stale entry is still evicted — the guard skips the write, not the cleanup');
  });

  test('a sweeper entry with no parsed session key does not open undefined.db', () => {
    // log._parsed?.workspace is optional-chained, so undefined reaches getDb, and
    // `${undefined}.db` is a real filename. "undefined" is also a registrable
    // workspace name ([a-z0-9-]), so the check has to reject the value, not the key.
    srv.app.gatewayClient.activityLogs.set('run-unparsed', {
      sessionKey: 'not-a-clawchats-key', steps: [], startTime: 0, _messageId: 'gw-activity-run-unparsed',
    });
    srv.app.gatewayClient._sweepStaleActivityLogs();

    assert.equal(dbExists(srv, 'undefined'), false, 'getDb(undefined) opened undefined.db');
    assert.equal(srv.app.gatewayClient._registeredDb(undefined), null);
    assert.equal(srv.app.gatewayClient._registeredDb(null), null);
  });

  test('a final reply for a workspace deleted mid-run does not recreate its database', async () => {
    await seedThenDelete(srv, 'ghost-final', 't1');

    srv.app.gatewayClient.handleChatEvent(
      { sessionKey: 'agent:main:ghost-final:chat:t1', state: 'final', message: { content: 'done' }, seq: 1 }, raw);

    assert.equal(dbExists(srv, 'ghost-final'), false);
  });

  test('a title reply for a workspace deleted mid-run does not recreate its database', async () => {
    await seedThenDelete(srv, 'ghost-title', 't1');
    // A title request is in flight for up to 30s — long enough to outlive the workspace.
    srv.app.gatewayClient._pendingTitleGens.set('__clawchats_title_ghost-title_t1',
      { threadId: 't1', workspace: 'ghost-title', reqId: 'title-1' });

    srv.app.gatewayClient.handleChatEvent(
      { sessionKey: 'agent:main:__clawchats_title_ghost-title_t1', state: 'final', message: { content: 'A Title' } }, raw);

    assert.equal(dbExists(srv, 'ghost-title'), false);
    assert.equal(srv.app.gatewayClient._pendingTitleGens.size, 0, 'the pending entry is still consumed');
  });

  test('a session key naming a prototype property is not treated as a registered workspace', async () => {
    // isValidWorkspaceName() accepts "constructor", and a bare `ws.workspaces[name]`
    // read finds Object.prototype.constructor — truthy — so the membership check passes
    // for a workspace that was never registered. Object.hasOwn is the fix, and the same
    // one the request boundary already makes in index.js handleRequest().
    for (const name of ['constructor', 'toString', 'valueOf']) {
      assert.equal(srv.app.gatewayClient._isRegisteredWorkspace(name), false, `${name} must not read as registered`);
    }

    srv.app.gatewayClient.handleChatEvent(
      { sessionKey: 'agent:main:constructor:chat:t1', state: 'final', message: { content: 'hi' }, seq: 1 }, raw);
    srv.app.gatewayClient.handleChatEvent(
      { sessionKey: 'agent:main:toString:chat:t1', state: 'aborted' }, raw);

    assert.equal(dbExists(srv, 'constructor'), false);
    assert.equal(dbExists(srv, 'toString'), false);
  });

  test('POST /api/active-thread cannot mint a database for an unregistered workspace', async () => {
    // This route takes the workspace from the body, so it bypasses the x-workspace
    // check in handleRequest() and lands on setActiveThread's own membership test.
    const proto = await srv.api('POST', '/api/active-thread', { body: { workspace: 'valueOf', threadId: 't1' } });
    assert.equal(proto.status, 200, 'the route still answers — it just must not open a database');
    assert.equal(dbExists(srv, 'valueOf'), false);

    const unknown = await srv.api('POST', '/api/active-thread', { body: { workspace: 'never-made', threadId: 't1' } });
    assert.equal(unknown.status, 200);
    assert.equal(dbExists(srv, 'never-made'), false);
  });

  test('no orphan database was left behind by any of the above', () => {
    // Whole-directory assertion: anything the guards missed shows up here even if no
    // individual test named it. Only the harness default survives — every workspace
    // these tests registered was deleted again.
    assert.deepEqual(dbFiles(srv), ['default.db']);
  });
});

// Guarding must not cost the behaviour the guarded paths existed for.
describe('registered workspaces still reach storage', () => {
  let srv;

  before(async () => {
    srv = await startTestServer();
    const created = await srv.api('POST', '/api/workspaces', { body: { name: 'alpha' } });
    assert.equal(created.status, 201);
  });
  after(async () => { await srv.close(); });

  async function pendingFlagOf(threadId) {
    const res = await srv.api('GET', `/api/threads/${threadId}/messages`, { headers: { 'x-workspace': 'alpha' } });
    assert.equal(res.status, 200);
    const activity = res.body.messages.find(m => m.role === 'assistant');
    assert.ok(activity, 'the activity event must have written an assistant row');
    return activity.metadata?.pending;
  }

  test('an activity event writes, and a following abort clears the pending flag', async () => {
    const thread = await srv.api('POST', '/api/threads', { headers: { 'x-workspace': 'alpha' }, body: { id: 'live-1' } });
    assert.equal(thread.status, 201);

    srv.app.gatewayClient.handleAgentEvent({
      runId: 'run-live', stream: 'thinking', data: { text: 'working' }, sessionKey: 'agent:main:alpha:chat:live-1',
    });
    assert.equal(await pendingFlagOf('live-1'), true, 'precondition: the activity row is pending');

    srv.app.gatewayClient.handleChatEvent({ sessionKey: 'agent:main:alpha:chat:live-1', state: 'aborted' }, raw);

    assert.equal(await pendingFlagOf('live-1'), undefined, 'the abort must still clear metadata.pending');
  });

  test('a final reply is still persisted', async () => {
    const thread = await srv.api('POST', '/api/threads', { headers: { 'x-workspace': 'alpha' }, body: { id: 'live-2' } });
    assert.equal(thread.status, 201);

    srv.app.gatewayClient.handleChatEvent(
      { sessionKey: 'agent:main:alpha:chat:live-2', state: 'final', message: { content: 'the answer' }, seq: 7 }, raw);

    const res = await srv.api('GET', '/api/threads/live-2/messages', { headers: { 'x-workspace': 'alpha' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.messages.at(-1)?.content, 'the answer');
  });

  test('a title reply is still written to the workspace that asked for it', async () => {
    const thread = await srv.api('POST', '/api/threads', { headers: { 'x-workspace': 'alpha' }, body: { id: 'live-3' } });
    assert.equal(thread.status, 201);
    srv.app.gatewayClient._pendingTitleGens.set('__clawchats_title_alpha_live-3',
      { threadId: 'live-3', workspace: 'alpha', reqId: 'title-live-3' });

    srv.app.gatewayClient.handleChatEvent(
      { sessionKey: 'agent:main:__clawchats_title_alpha_live-3', state: 'final', message: { content: 'Live Title' } }, raw);

    const res = await srv.api('GET', '/api/threads/live-3', { headers: { 'x-workspace': 'alpha' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.thread.title, 'Live Title');
  });

  test('active-thread still clears unreads for a registered workspace', async () => {
    const thread = await srv.api('POST', '/api/threads', { headers: { 'x-workspace': 'alpha' }, body: { id: 'live-4' } });
    assert.equal(thread.status, 201);
    srv.app.gatewayClient.handleChatEvent(
      { sessionKey: 'agent:main:alpha:chat:live-4', state: 'final', message: { content: 'unread reply' }, seq: 1 }, raw);

    const before = await srv.api('GET', '/api/threads/live-4', { headers: { 'x-workspace': 'alpha' } });
    assert.equal(before.body.thread.unread_count, 1, 'precondition: the reply is unread');

    const res = await srv.api('POST', '/api/active-thread', { body: { workspace: 'alpha', threadId: 'live-4' } });
    assert.equal(res.status, 200);

    const after = await srv.api('GET', '/api/threads/live-4', { headers: { 'x-workspace': 'alpha' } });
    assert.equal(after.body.thread.unread_count, 0, 'setActiveThread must still clear unreads');
  });
});
