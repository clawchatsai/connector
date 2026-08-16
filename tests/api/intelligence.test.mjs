// Contract tests for the conversation-intelligence store (CLA-1314).
//
// request-workspace.test.mjs already covers the workspace-scoped round-trip and
// the cross-workspace non-leak (CLA-1279). What is left is the shape the
// frontend actually reads: the empty-state sentinel, replace-not-append on
// write, and isolation between two threads inside one workspace — the store is
// one <threadId>.json per workspace directory, so per-thread separation is a
// different property from per-workspace separation.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, createThread } from '../helpers/harness.mjs';

describe('thread intelligence', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  test('a thread with no intelligence returns the empty-state sentinel', async () => {
    const id = await createThread(srv.api);
    const res = await srv.api('GET', `/api/threads/${id}/intelligence`);
    assert.equal(res.status, 200);
    // currentVersion is -1, not 0 or null: the frontend indexes versions[] with
    // it, so the sentinel is part of the contract, not an implementation detail.
    assert.deepEqual(res.body, { versions: [], currentVersion: -1 });
  });

  test('a second save replaces the stored versions rather than appending', async () => {
    const id = await createThread(srv.api);
    const first = { versions: [{ content: 'draft one' }, { content: 'draft two' }], currentVersion: 1 };
    const second = { versions: [{ content: 'rewritten' }], currentVersion: 0 };

    const saveFirst = await srv.api('POST', `/api/threads/${id}/intelligence`, { body: first });
    assert.equal(saveFirst.status, 200);
    const saveSecond = await srv.api('POST', `/api/threads/${id}/intelligence`, { body: second });
    assert.equal(saveSecond.status, 200);
    assert.deepEqual(saveSecond.body.versions, second.versions, 'the write echoes the replacement');

    const read = await srv.api('GET', `/api/threads/${id}/intelligence`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.versions, second.versions, 'the read reflects the replacement');
    assert.equal(read.body.versions.length, 1, 'the first save\'s versions are gone, not merged');
    assert.equal(read.body.currentVersion, 0);
  });

  test('two threads in the same workspace do not see each other\'s intelligence', async () => {
    const [a, b] = [await createThread(srv.api), await createThread(srv.api)];
    const saved = await srv.api('POST', `/api/threads/${a}/intelligence`, {
      body: { versions: [{ content: 'belongs to a' }], currentVersion: 0 },
    });
    assert.equal(saved.status, 200);

    const readB = await srv.api('GET', `/api/threads/${b}/intelligence`);
    assert.equal(readB.status, 200);
    assert.deepEqual(readB.body, { versions: [], currentVersion: -1 }, 'b sees the empty state');

    const readA = await srv.api('GET', `/api/threads/${a}/intelligence`);
    assert.deepEqual(readA.body.versions, [{ content: 'belongs to a' }], 'a still reads its own');
  });
});
