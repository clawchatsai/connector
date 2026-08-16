// Contract tests for repairSessionKeyWorkspace() (CLA-1274).
//
// The repair re-keys rows whose session_key names a workspace other than the
// database file they live in. It runs on database open, which makes it an
// automatic write to user data on a read path — so what it must NOT touch
// matters as much as what it fixes.
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

    // Reach the mis-keyed state the way a user can: export carries session_key
    // (SELECT *) and import preserves it, so a round-trip into another workspace
    // lands a row in second.db that still names "default".
    const created = await srv.api('POST', '/api/threads');
    const threadId = created.body.thread.id;
    const staleKey = created.body.thread.session_key;
    assert.equal(staleKey, `agent:main:default:chat:${threadId}`);

    const exported = await srv.api('GET', '/api/export');
    assert.equal(exported.body.threads[0].session_key, staleKey, 'export must carry the key for this to be reachable');

    const imported = await srv.api('POST', '/api/import', {
      headers: { 'x-workspace': 'second' },
      body: { threads: exported.body.threads },
    });
    assert.equal(imported.body.threadsImported, 1);

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
    await srv.api('POST', '/api/import', {
      headers: { 'x-workspace': 'second' },
      body: {
        threads: [
          { id: 'ok-main', session_key: 'agent:main:second:chat:ok-main' },
          { id: 'ok-legacy', session_key: 'agent:legacy:second:chat:ok-legacy' },
          { id: 'not-a-key', session_key: 'garbage' },
        ],
      },
    });

    const next = await reopen();
    const list = await next.api('GET', '/api/threads', { headers: { 'x-workspace': 'second' } });
    const byId = Object.fromEntries(list.body.threads.map(t => [t.id, t.session_key]));
    assert.equal(byId['ok-main'], 'agent:main:second:chat:ok-main');
    assert.equal(byId['ok-legacy'], 'agent:legacy:second:chat:ok-legacy',
      'the agent segment belongs to PATCH /api/workspaces/:name, not to this repair');
    assert.equal(byId['not-a-key'], 'garbage', 'foreign key shapes are not rewritten');
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
