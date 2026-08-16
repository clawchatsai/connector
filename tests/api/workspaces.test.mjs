// Contract tests for the workspaces API (CLA-1269).
//
// Workspaces are the top-level tenancy boundary: each one owns its own SQLite
// file under dataDir and its own row of threads/messages. These tests assert
// the CRUD contract in server/controllers/workspaces.js plus the isolation
// guarantee that makes the per-workspace-db design worth having.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from '../helpers/harness.mjs';

describe('GET /api/workspaces', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('fresh server reports the single default workspace', async () => {
    const res = await srv.api('GET', '/api/workspaces');
    assert.equal(res.status, 200);
    assert.equal(res.body.active, 'default');
    assert.equal(res.body.workspaces.length, 1);
    const [ws] = res.body.workspaces;
    assert.equal(ws.name, 'default');
    assert.equal(ws.unread_count, 0);
  });

  test('unread_count is the sum of each workspace threads.unread_count', async () => {
    await srv.api('POST', '/api/workspaces', { body: { name: 'ws-agg' } });

    const t1 = await srv.api('POST', '/api/threads', { headers: { 'x-workspace': 'ws-agg' } });
    const t2 = await srv.api('POST', '/api/threads', { headers: { 'x-workspace': 'ws-agg' } });
    assert.equal(t1.status, 201);
    assert.equal(t2.status, 201);

    await srv.api('PATCH', `/api/threads/${t1.body.thread.id}`, {
      headers: { 'x-workspace': 'ws-agg' },
      body: { unread_count: 3 },
    });
    await srv.api('PATCH', `/api/threads/${t2.body.thread.id}`, {
      headers: { 'x-workspace': 'ws-agg' },
      body: { unread_count: 2 },
    });

    const res = await srv.api('GET', '/api/workspaces');
    assert.equal(res.status, 200);
    const agg = res.body.workspaces.find(w => w.name === 'ws-agg');
    const def = res.body.workspaces.find(w => w.name === 'default');
    assert.equal(agg.unread_count, 5);
    assert.equal(def.unread_count, 0, 'default workspace threads must not leak into ws-agg total');
  });

  test('workspaces are sorted by order, unset order sorts last', async () => {
    await srv.api('POST', '/api/workspaces', { body: { name: 'ws-b' } });
    await srv.api('POST', '/api/workspaces', { body: { name: 'ws-c' } });
    // 'default' is left with no explicit order (falls back to 999).
    await srv.api('POST', '/api/workspaces/reorder', { body: { order: ['ws-c', 'ws-b'] } });

    const res = await srv.api('GET', '/api/workspaces');
    assert.deepEqual(res.body.workspaces.map(w => w.name), ['ws-c', 'ws-b', 'default', 'ws-agg']);
  });
});

describe('POST /api/workspaces', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('creates a workspace with defaults and its own db file', async () => {
    const res = await srv.api('POST', '/api/workspaces', { body: { name: 'team-a' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.workspace.name, 'team-a');
    assert.equal(res.body.workspace.label, 'team-a', 'label defaults to the name');
    assert.equal(res.body.workspace.agent, 'main', 'agent defaults to main');
    assert.equal(res.body.workspace.color, null);
    assert.equal(res.body.workspace.icon, null);
    assert.equal(typeof res.body.workspace.createdAt, 'number');

    assert.equal(fs.existsSync(path.join(srv.dataDir, 'team-a.db')), true, 'db file must be created on the spot');

    const list = await srv.api('GET', '/api/workspaces');
    assert.ok(list.body.workspaces.some(w => w.name === 'team-a'));
  });

  test('honors an explicit label, color and icon', async () => {
    const res = await srv.api('POST', '/api/workspaces', {
      body: { name: 'team-b', label: 'Team B', color: '#fff', icon: 'rocket' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.workspace.label, 'Team B');
    assert.equal(res.body.workspace.color, '#fff');
    assert.equal(res.body.workspace.icon, 'rocket');
  });

  test('rejects names outside [a-z0-9-]{1,32}', async () => {
    for (const bad of ['', 'UPPER', 'has space', 'a'.repeat(33), 'sym$bol', undefined]) {
      const res = await srv.api('POST', '/api/workspaces', { body: { name: bad } });
      assert.equal(res.status, 400, `expected rejection for ${JSON.stringify(bad)}`);
      assert.match(res.body.error, /Name must be/i);
    }
  });

  test('rejects a duplicate name with 409', async () => {
    const first = await srv.api('POST', '/api/workspaces', { body: { name: 'dup-ws' } });
    assert.equal(first.status, 201);
    const second = await srv.api('POST', '/api/workspaces', { body: { name: 'dup-ws' } });
    assert.equal(second.status, 409);
  });
});

describe('PATCH /api/workspaces/:name', () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
    await srv.api('POST', '/api/workspaces', { body: { name: 'ws-patch', label: 'Original', color: '#111', icon: 'flag' } });
  });
  after(async () => { await srv.close(); });

  test('updates label, color and icon', async () => {
    const res = await srv.api('PATCH', '/api/workspaces/ws-patch', {
      body: { label: 'Renamed', color: '#222', icon: 'star' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.workspace.label, 'Renamed');
    assert.equal(res.body.workspace.color, '#222');
    assert.equal(res.body.workspace.icon, 'star');
  });

  test('a partial update leaves other fields untouched', async () => {
    const res = await srv.api('PATCH', '/api/workspaces/ws-patch', { body: { color: '#333' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.workspace.color, '#333');
    assert.equal(res.body.workspace.label, 'Renamed', 'label from the previous test must survive an unrelated patch');
    assert.equal(res.body.workspace.icon, 'star');
  });

  test('404s for an unknown workspace', async () => {
    const res = await srv.api('PATCH', '/api/workspaces/does-not-exist', { body: { label: 'x' } });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/workspaces/:name', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('refuses to delete the only remaining workspace', async () => {
    const res = await srv.api('DELETE', '/api/workspaces/default');
    assert.equal(res.status, 400);
    const list = await srv.api('GET', '/api/workspaces');
    assert.equal(list.body.workspaces.length, 1, 'default must still be there');
  });

  test('404s for an unknown workspace', async () => {
    const res = await srv.api('DELETE', '/api/workspaces/does-not-exist');
    assert.equal(res.status, 404);
  });

  test('deletes a non-active workspace and removes its db file', async () => {
    await srv.api('POST', '/api/workspaces', { body: { name: 'ws-doomed' } });
    // Touch the db so it's actually created on disk before we assert it's gone.
    await srv.api('GET', '/api/threads', { headers: { 'x-workspace': 'ws-doomed' } });
    const dbPath = path.join(srv.dataDir, 'ws-doomed.db');
    assert.equal(fs.existsSync(dbPath), true);

    const res = await srv.api('DELETE', '/api/workspaces/ws-doomed');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(fs.existsSync(dbPath), false, 'db file must be removed');

    const list = await srv.api('GET', '/api/workspaces');
    assert.ok(!list.body.workspaces.some(w => w.name === 'ws-doomed'));
  });

  test('reassigns active to a survivor when the active workspace is deleted', async () => {
    await srv.api('POST', '/api/workspaces', { body: { name: 'ws-active-victim' } });
    await srv.api('POST', '/api/workspaces/ws-active-victim/activate');
    let health = await srv.api('GET', '/api/health');
    assert.equal(health.body.workspace, 'ws-active-victim');

    const del = await srv.api('DELETE', '/api/workspaces/ws-active-victim');
    assert.equal(del.status, 200);

    health = await srv.api('GET', '/api/health');
    assert.notEqual(health.body.workspace, 'ws-active-victim', 'active must move off the deleted workspace');
    const list = await srv.api('GET', '/api/workspaces');
    assert.equal(list.body.active, health.body.workspace);
  });
});

describe('POST /api/workspaces/:name/activate', () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
    await srv.api('POST', '/api/workspaces', { body: { name: 'ws-act' } });
  });
  after(async () => { await srv.close(); });

  test('404s for an unknown workspace', async () => {
    const res = await srv.api('POST', '/api/workspaces/does-not-exist/activate');
    assert.equal(res.status, 404);
  });

  test('activating flips active in the workspace list and health check', async () => {
    const res = await srv.api('POST', '/api/workspaces/ws-act/activate');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.workspace.name, 'ws-act');

    const list = await srv.api('GET', '/api/workspaces');
    assert.equal(list.body.active, 'ws-act');

    const health = await srv.api('GET', '/api/health');
    assert.equal(health.body.workspace, 'ws-act');
  });
});

describe('POST /api/workspaces/reorder', () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
    await srv.api('POST', '/api/workspaces', { body: { name: 'r1' } });
    await srv.api('POST', '/api/workspaces', { body: { name: 'r2' } });
    await srv.api('POST', '/api/workspaces', { body: { name: 'r3' } });
  });
  after(async () => { await srv.close(); });

  test('persists the requested order and it is reflected in the list', async () => {
    const res = await srv.api('POST', '/api/workspaces/reorder', { body: { order: ['r3', 'r1', 'default', 'r2'] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const list = await srv.api('GET', '/api/workspaces');
    assert.deepEqual(list.body.workspaces.map(w => w.name), ['r3', 'r1', 'default', 'r2']);
  });

  test('unknown names in the order array are ignored rather than erroring', async () => {
    const res = await srv.api('POST', '/api/workspaces/reorder', { body: { order: ['r2', 'ghost-workspace', 'r1'] } });
    assert.equal(res.status, 200);
  });

  test('400s when order is not an array', async () => {
    const res = await srv.api('POST', '/api/workspaces/reorder', { body: { order: 'r1' } });
    assert.equal(res.status, 400);
  });
});

describe('workspace data isolation', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('a thread created in one workspace is invisible from another', async () => {
    await srv.api('POST', '/api/workspaces', { body: { name: 'iso-a' } });
    await srv.api('POST', '/api/workspaces', { body: { name: 'iso-b' } });

    const created = await srv.api('POST', '/api/threads', { headers: { 'x-workspace': 'iso-a' } });
    assert.equal(created.status, 201);
    const threadId = created.body.thread.id;

    const fromA = await srv.api('GET', '/api/threads', { headers: { 'x-workspace': 'iso-a' } });
    assert.ok(fromA.body.threads.some(t => t.id === threadId), 'the owning workspace must see its thread');

    const fromB = await srv.api('GET', '/api/threads', { headers: { 'x-workspace': 'iso-b' } });
    assert.ok(!fromB.body.threads.some(t => t.id === threadId), 'a sibling workspace must not see it');

    const directGetFromB = await srv.api('GET', `/api/threads/${threadId}`, { headers: { 'x-workspace': 'iso-b' } });
    assert.equal(directGetFromB.status, 404, 'the thread id must not resolve from the wrong workspace db');

    assert.equal(fs.existsSync(path.join(srv.dataDir, 'iso-a.db')), true);
    assert.equal(fs.existsSync(path.join(srv.dataDir, 'iso-b.db')), true);
  });
});

// CLA-1274. session_key is the cross-workspace routing seam: parseSessionKey()
// resolves gateway events back to a workspace by reading slot 3. A row written to
// <target>.db while naming <active> routes its events to a workspace where it does
// not exist, so the key must name the workspace the request targets.
describe('session_key names the requesting workspace', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('POST /api/threads keys against x-workspace, not the active workspace', async () => {
    await srv.api('POST', '/api/workspaces', { body: { name: 'key-target' } });
    const active = await srv.api('GET', '/api/workspaces');
    assert.equal(active.body.active, 'default', 'precondition: a different workspace is active');

    const created = await srv.api('POST', '/api/threads', { headers: { 'x-workspace': 'key-target' } });
    assert.equal(created.status, 201);
    const { id, session_key } = created.body.thread;
    assert.equal(session_key, `agent:main:key-target:chat:${id}`,
      'the key must name the targeted workspace; naming the active one is CLA-1274');

    // And the row really does live in the targeted workspace's db.
    const fromTarget = await srv.api('GET', `/api/threads/${id}`, { headers: { 'x-workspace': 'key-target' } });
    assert.equal(fromTarget.status, 200);
    assert.equal(fromTarget.body.thread.session_key, session_key);
  });

  test('POST /api/threads with no header still keys against the active workspace', async () => {
    const created = await srv.api('POST', '/api/threads');
    assert.equal(created.status, 201);
    const { id, session_key } = created.body.thread;
    assert.equal(session_key, `agent:main:default:chat:${id}`);
  });

  test('POST /api/import mints keys against x-workspace when the thread carries none', async () => {
    await srv.api('POST', '/api/workspaces', { body: { name: 'key-import' } });
    const res = await srv.api('POST', '/api/import', {
      headers: { 'x-workspace': 'key-import' },
      body: { threads: [{ id: 'imp-1', title: 'No key' }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.threadsImported, 1);

    const list = await srv.api('GET', '/api/threads', { headers: { 'x-workspace': 'key-import' } });
    const imported = list.body.threads.find(t => t.id === 'imp-1');
    assert.equal(imported.session_key, 'agent:main:key-import:chat:imp-1');
  });
});

// CLA-1310. x-workspace names the tenancy boundary, and getDb() opens (creating it
// if absent) whatever file the name resolves to. workspaces.json is the register of
// what exists — a name that is not in it has no owner, and GET /api/workspaces never
// lists it, so the storage it mints can never be deleted through the API either.
describe('x-workspace must name a registered workspace', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('a well-formed but unregistered name is rejected and mints nothing', async () => {
    const res = await srv.api('GET', '/api/threads', { headers: { 'x-workspace': 'ghost' } });
    assert.equal(res.status, 404);
    assert.equal(fs.existsSync(path.join(srv.dataDir, 'ghost.db')), false,
      'a rejected request must not leave a database behind');

    const list = await srv.api('GET', '/api/workspaces');
    assert.ok(!list.body.workspaces.some(w => w.name === 'ghost'));
  });

  test('a name that collides with an Object prototype key is not registered', async () => {
    // isValidWorkspaceName() accepts "constructor", and a bare property read on the
    // workspaces map would report it as present.
    const res = await srv.api('GET', '/api/threads', { headers: { 'x-workspace': 'constructor' } });
    assert.equal(res.status, 404);
    assert.equal(fs.existsSync(path.join(srv.dataDir, 'constructor.db')), false);
  });

  test('a registered workspace is served as before', async () => {
    await srv.api('POST', '/api/workspaces', { body: { name: 'real' } });
    const res = await srv.api('GET', '/api/threads', { headers: { 'x-workspace': 'real' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.threads, []);
  });

  test('a malformed name still fails validation before the register is consulted', async () => {
    const res = await srv.api('GET', '/api/threads', { headers: { 'x-workspace': '../../etc' } });
    assert.equal(res.status, 400);
  });

  test('no header still resolves to the active workspace', async () => {
    const res = await srv.api('GET', '/api/threads');
    assert.equal(res.status, 200);
  });
});
