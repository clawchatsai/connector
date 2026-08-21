// Migration test for the CLA-1509 removal of `threads.last_session_id`.
//
// The rest of the suite cannot cover this. Every other test opens a database this
// build created, where `CREATE TABLE IF NOT EXISTS` never adds the column — so the
// `ALTER TABLE threads DROP COLUMN` in migrate() throws "no such column", is
// swallowed by its catch, and the assertions pass without the drop ever running.
// A migration that silently did nothing would look identical.
//
// So the legacy column is added back by hand, with a value in it, and the database
// is reopened in a fresh server. That is the only shape that exercises the drop:
// a database an older build wrote, which is exactly the population the migration
// exists for.
//
// Why the drop matters and a NULL column would not do: before CLA-1503 the column
// took a caller-supplied filename and was resolved inside a gateway session store
// that is shared across every workspace (see session-id-ownership.test.mjs). CLA-1503
// removed the writers and cleared the values; this removes the column, so a future
// reader cannot be added against state no server-side code fills.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startTestServer } from '../helpers/harness.mjs';
import { removeSandboxHome } from '../helpers/sandbox-home.mjs';

/** Stop a server without deleting its data dir, so the next one can reopen it. */
async function softClose(srv) {
  srv.app.shutdown();
  await new Promise(resolve => srv.server.close(resolve));
}

function threadColumns(db) {
  return db.prepare('PRAGMA table_info(threads)').all().map(c => c.name);
}

describe('threads.last_session_id is dropped on open (CLA-1509)', () => {
  let dataDir;
  const servers = [];

  async function reopen() {
    const srv = await startTestServer({ dataDir });
    servers.push(srv);
    return srv;
  }

  before(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-test-lsid-')); });
  after(async () => {
    for (const srv of servers) await softClose(srv);
    fs.rmSync(dataDir, { recursive: true, force: true });
    removeSandboxHome();
  });

  test('an older database keeps its threads and loses the column', async () => {
    const first = await reopen();
    const created = await first.api('POST', '/api/threads', { body: { title: 'Survives the migration' } });
    assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
    const threadId = created.body.thread.id;
    const sessionKey = created.body.thread.session_key;

    const msg = await first.api('POST', `/api/threads/${threadId}/messages`, {
      body: { id: 'm-legacy', role: 'user', content: 'hello from an older build', timestamp: Date.now() },
    });
    assert.equal(msg.status, 201, `message insert failed: ${JSON.stringify(msg.body)}`);

    // Read the title back rather than asserting the one that was posted: sending the
    // first message re-titles the thread from its content. What this test is about is
    // that whatever the row held survives the rewrite, not what put it there.
    const titleBefore = (await first.api('GET', `/api/threads/${threadId}`)).body.thread.title;

    // Put the database back into its pre-CLA-1509 shape: the column present and
    // holding the kind of caller-chosen filename CLA-1503 used to accept.
    const db = first.app.getDb('default');
    db.exec('ALTER TABLE threads ADD COLUMN last_session_id TEXT');
    db.prepare('UPDATE threads SET last_session_id = ? WHERE id = ?').run('victim-from-another-workspace', threadId);
    assert.ok(
      threadColumns(db).includes('last_session_id'),
      'the legacy column was not restored, so this test would pass without exercising the drop',
    );
    await softClose(first);
    servers.length = 0;

    // A fresh process opens it and migrates.
    const next = await reopen();
    assert.ok(
      !threadColumns(next.app.getDb('default')).includes('last_session_id'),
      'migrate() left last_session_id on a database that had it — the ALTER was swallowed',
    );

    // The drop must cost nothing else. SQLite's DROP COLUMN rewrites the table, so
    // the row and its key surviving is the part worth asserting, not a formality.
    const { thread } = (await next.api('GET', `/api/threads/${threadId}`)).body;
    assert.equal(thread.title, titleBefore, 'the thread title did not survive the table rewrite');
    assert.equal(thread.session_key, sessionKey);
    assert.ok(!('last_session_id' in thread), 'the migrated row still carries last_session_id');

    const { messages } = (await next.api('GET', `/api/threads/${threadId}/messages`)).body;
    assert.equal(messages.length, 1, 'the child messages did not survive the table rewrite');
    assert.equal(messages[0].content, 'hello from an older build');
  });

  test('opening an already-migrated database again is a no-op', async () => {
    // The ALTER is best-effort like the others in migrate(); the point of this is
    // that its failure on the common path stays silent and harmless.
    const again = await reopen();
    assert.ok(!threadColumns(again.app.getDb('default')).includes('last_session_id'));
    assert.equal((await again.api('GET', '/api/threads')).status, 200);
  });
});
