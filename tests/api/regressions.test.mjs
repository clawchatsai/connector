// Regressions found by the first pass of contract coverage (CLA-1269).
//
// Each of these was live on main at 932f833. They are the concrete answer to
// "a broken app.js gets caught, a broken endpoint does not."
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from '../helpers/harness.mjs';

describe('regressions', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('PUT /api/prompts persists instead of throwing on node:sqlite', async () => {
    // db.transaction() is a better-sqlite3 API that node:sqlite's DatabaseSync
    // does not implement, so this route answered 500 for every caller.
    const prompts = [
      { id: 'p1', title: 'First', content: 'body one', category: 'general', variables: ['a'] },
      { id: 'p2', title: 'Second', content: 'body two' },
    ];
    const put = await srv.api('PUT', '/api/prompts', { body: prompts });
    assert.equal(put.status, 200, `expected 200, got ${put.status}: ${JSON.stringify(put.body)}`);
    assert.deepEqual(put.body, { ok: true });

    const get = await srv.api('GET', '/api/prompts');
    assert.equal(get.status, 200);
    assert.equal(get.body.length, 2);
    const first = get.body.find(p => p.id === 'p1');
    assert.equal(first.title, 'First');
    assert.equal(first.content, 'body one');
    assert.deepEqual(first.variables, ['a'], 'variables should round-trip as parsed JSON');
    // Defaults applied by the upsert.
    const second = get.body.find(p => p.id === 'p2');
    assert.equal(second.category, '');
    assert.deepEqual(second.variables, []);
  });

  test('PUT /api/prompts replaces the whole library', async () => {
    await srv.api('PUT', '/api/prompts', { body: [{ id: 'keep', title: 'K', content: 'c' }] });
    const get = await srv.api('GET', '/api/prompts');
    assert.deepEqual(get.body.map(p => p.id), ['keep'], 'prior rows should be deleted');
  });

  test('x-workspace cannot escape the data directory', async () => {
    // The header is interpolated into `<name>.db` and resolved BEFORE auth, so a
    // traversal created (and opened) a SQLite file anywhere the process could write.
    //
    // Rooted in a sandbox this test owns, so the escape target is somewhere we can
    // guarantee is clean beforehand — asserting "file absent" against a shared temp
    // directory would pass or fail on leftovers from previous runs.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cla1269-traversal-'));
    const escape = path.join(sandbox, 'escaped');
    const sandboxed = await startTestServer({ dataDir: path.join(sandbox, 'data') });
    try {
      assert.equal(fs.existsSync(escape + '.db'), false, 'sandbox must start clean');

      const res = await sandboxed.api('GET', '/api/health', {
        headers: { 'x-workspace': '../escaped' },
      });

      assert.equal(res.status, 400, 'traversal should be rejected, not served');
      assert.match(res.body.error, /x-workspace/i);
      for (const suffix of ['.db', '.db-wal', '.db-shm']) {
        assert.equal(fs.existsSync(escape + suffix), false, `must not create ${escape + suffix}`);
      }
    } finally {
      await sandboxed.close();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('x-workspace rejects other out-of-charset names', async () => {
    for (const bad of ['../../etc/passwd', 'Upper', 'has space', 'semi;colon', 'a'.repeat(33), 'dot.dot']) {
      const res = await srv.api('GET', '/api/health', { headers: { 'x-workspace': bad } });
      assert.equal(res.status, 400, `expected rejection for ${JSON.stringify(bad)}`);
    }
  });

  test('an empty x-workspace is treated as absent, not invalid', async () => {
    // An empty header is indistinguishable from an unsent one, so it must fall
    // back to the active workspace rather than 400.
    const res = await srv.api('GET', '/api/health', { headers: { 'x-workspace': '' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.workspace, 'default');
  });

  test('x-workspace still routes valid names to their own database', async () => {
    // Registered first: since CLA-1310 a name the register does not know is a 404
    // rather than a freshly minted database.
    await srv.api('POST', '/api/workspaces', { body: { name: 'alt-ws-1' } });
    const res = await srv.api('GET', '/api/health', { headers: { 'x-workspace': 'alt-ws-1' } });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(srv.dataDir, 'alt-ws-1.db')), true);
  });

  test('a database that cannot be opened answers 500 and leaves the process alive', async () => {
    // Database resolution happens before route()'s try/catch. Previously any
    // throw here escaped as an unhandled rejection, which Node turns into a
    // process exit — an unauthenticated request could kill the backend.
    // A directory where the .db file should be makes SQLite fail to open it.
    //
    // Own sandbox: the workspace has to be registered (CLA-1310) yet never
    // successfully opened, so the register is seeded on disk before boot and the
    // directory put in the way while the db cache is still empty.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cla1310-unopenable-'));
    const dataDir = path.join(sandbox, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'workspaces.json'), JSON.stringify({
      active: 'default',
      workspaces: { default: { name: 'default' }, blocked: { name: 'blocked' } },
    }));
    fs.mkdirSync(path.join(dataDir, 'blocked.db'), { recursive: true });
    const sandboxed = await startTestServer({ dataDir });
    try {
      const res = await sandboxed.api('GET', '/api/health', { headers: { 'x-workspace': 'blocked' } });
      assert.equal(res.status, 500, 'should answer, not crash');

      // The server must still be serving after the failure.
      const after = await sandboxed.api('GET', '/api/health');
      assert.equal(after.status, 200, 'server should survive the failed request');
    } finally {
      await sandboxed.close();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
