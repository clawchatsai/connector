// Contract tests for repairSessionKeyWorkspace() (CLA-1274).
//
// The repair re-keys rows whose session_key names a workspace other than the
// database file they live in. It runs on database open, which makes it an
// automatic write to user data on a read path — so what it must NOT touch
// matters as much as what it fixes.
//
// These rows are seeded straight into the database rather than through the API.
// Since CLA-1296 no live route stores a key naming another workspace — POST
// /api/threads, POST /api/threads/:id/move and POST /api/import all mint or
// re-mint against the workspace being written to — so what is left for this
// repair is rows an older build already wrote to disk, and a direct insert is
// the only faithful way to reproduce one. Arming these through /api/import (as
// this file used to) would now assert nothing: import re-keys the row on the
// way in, so the repair would have nothing to do and the tests would pass
// without ever exercising it.
//
// The sessions directory is resolved from os.homedir() at module load
// (server/config.js), so HOME is redirected at a sandbox before the server is
// imported — harness.mjs owns that ordering now. See helpers/sandbox-home.mjs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startTestServer } from '../helpers/harness.mjs';
import { sandboxSessionsDir, removeSandboxHome } from '../helpers/sandbox-home.mjs';

const sessionsDir = sandboxSessionsDir('main');

/** Stop a server without deleting its data dir, so the next one can reopen it. */
async function softClose(srv) {
  srv.app.shutdown();
  await new Promise(resolve => srv.server.close(resolve));
}

function readSessions() {
  return JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8'));
}

/** Write a thread row directly into a workspace's database — see the file header. */
function seedRow(srv, workspace, id, sessionKey) {
  const now = Date.now();
  srv.app.getDb(workspace)
    .prepare('INSERT INTO threads (id, session_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, sessionKey, 'Seeded by an older build', now, now);
}

describe('repairSessionKeyWorkspace', () => {
  let dataDir;
  const servers = [];

  /** Boot another server over the same data dir, forcing a fresh database open. */
  async function reopen() {
    const srv = await startTestServer({ dataDir });
    servers.push(srv);
    return srv;
  }

  before(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-test-repair-')); });
  after(async () => {
    for (const srv of servers) await softClose(srv);
    fs.rmSync(dataDir, { recursive: true, force: true });
    removeSandboxHome();
  });

  test('re-keys a row that names a workspace other than its own database', async () => {
    const srv = await reopen();
    await srv.api('POST', '/api/workspaces', { body: { name: 'second' } });

    // A real thread in "default", and a row in second.db carrying that same key —
    // the shape an export/import round-trip into another workspace left behind
    // before CLA-1296 re-keyed it on the way in.
    const created = await srv.api('POST', '/api/threads');
    const threadId = created.body.thread.id;
    const staleKey = created.body.thread.session_key;
    assert.equal(staleKey, `agent:main:default:chat:${threadId}`);

    seedRow(srv, 'second', threadId, staleKey);

    // A live gateway session for the ORIGINAL owner, "default". This is the state
    // the repair used to destroy.
    fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify({ [staleKey]: { sessionId: 'sess-live' } }));
    fs.writeFileSync(path.join(sessionsDir, 'sess-live.jsonl'), '{"role":"user"}\n');

    // A fresh process opens second.db for the first time and repairs it.
    const next = await reopen();
    const list = await next.api('GET', '/api/threads', { headers: { 'x-workspace': 'second' } });
    assert.equal(list.body.threads[0].session_key, `agent:main:second:chat:${threadId}`,
      'the row lives in second.db, so its key must name "second"');

    // The original workspace is untouched: same row, same key.
    const fromDefault = await next.api('GET', `/api/threads/${threadId}`);
    assert.equal(fromDefault.body.thread.session_key, staleKey);
  });

  test('leaves the gateway session under the stale key alone', async () => {
    // sessions.json is resolved per AGENT, not per workspace, and keyed by the
    // full session key — so entries for every workspace sharing an agent live in
    // one file. Deleting the stale key here would destroy a transcript that
    // "default" still legitimately owns and is still using.
    const store = readSessions();
    assert.equal(Object.keys(store).length, 1, 'the stale key must survive the repair');
    assert.ok(fs.existsSync(path.join(sessionsDir, 'sess-live.jsonl')),
      'another workspace\'s live transcript must not be deleted by repairing this one');
  });

  test('leaves correctly-keyed rows alone, including a non-main agent segment', async () => {
    const srv = await reopen();
    seedRow(srv, 'second', 'ok-main', 'agent:main:second:chat:ok-main');
    seedRow(srv, 'second', 'ok-legacy', 'agent:legacy:second:chat:ok-legacy');
    seedRow(srv, 'second', 'not-a-key', 'garbage');

    const next = await reopen();
    const list = await next.api('GET', '/api/threads', { headers: { 'x-workspace': 'second' } });
    const byId = Object.fromEntries(list.body.threads.map(t => [t.id, t.session_key]));
    assert.equal(byId['ok-main'], 'agent:main:second:chat:ok-main');
    assert.equal(byId['ok-legacy'], 'agent:legacy:second:chat:ok-legacy',
      'the agent segment belongs to PATCH /api/workspaces/:name, not to this repair');
    assert.equal(byId['not-a-key'], 'garbage', 'foreign key shapes are not rewritten');
  });

  // CLA-1296. The guard used to be a hand-rolled `parts.length >= 5` split, looser
  // than the anchored 5-segment regex parseSessionKey() actually applies. A
  // 6-segment key passed it, so the repair rewrote a key the parser rejects and
  // dropped the trailing segments — a silent edit to a row it cannot interpret.
  test('leaves a key with more segments than parseSessionKey() accepts alone', async () => {
    const srv = await reopen();
    seedRow(srv, 'second', 'six-seg', 'agent:main:default:chat:a:b');

    const next = await reopen();
    const row = await next.api('GET', '/api/threads/six-seg', { headers: { 'x-workspace': 'second' } });
    assert.equal(row.body.thread.session_key, 'agent:main:default:chat:a:b',
      'a key the parser rejects routes nowhere whatever its workspace segment says, so it is not this repair\'s to rewrite');
  });

  // Same boundary from the other side: every segment of the regex is `[^:]+`, so an
  // empty one is not a key either, even though the old split-based guard accepted it.
  test('leaves a key with an empty segment alone', async () => {
    const srv = await reopen();
    seedRow(srv, 'second', 'empty-seg', 'agent::default:chat:empty-seg');

    const next = await reopen();
    const row = await next.api('GET', '/api/threads/empty-seg', { headers: { 'x-workspace': 'second' } });
    assert.equal(row.body.thread.session_key, 'agent::default:chat:empty-seg');
  });

  test('is idempotent across repeated opens', async () => {
    const before = await (await reopen()).api('GET', '/api/threads', { headers: { 'x-workspace': 'second' } });
    const after = await (await reopen()).api('GET', '/api/threads', { headers: { 'x-workspace': 'second' } });
    assert.deepEqual(
      after.body.threads.map(t => [t.id, t.session_key]).sort(),
      before.body.threads.map(t => [t.id, t.session_key]).sort(),
    );
  });
});
