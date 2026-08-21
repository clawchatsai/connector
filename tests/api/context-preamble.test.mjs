// buildContextPreamble() contract tests — the fourth consumer of
// sessionTranscriptPath(), and the one that did not check its null return (CLA-1496
// review follow-up).
//
// Two things make this worth pinning rather than leaving to inspection:
//
//   1. The function had no test coverage at all, while sitting on the message-send
//      path via POST /api/threads/:id/context-fill.
//   2. The missing null check was invisible in behaviour. fs.readFileSync(null)
//      throws ERR_INVALID_ARG_TYPE, not ENOENT, and the bare catch here — commented
//      `/* file not found */` — swallowed both. So the endpoint answered correctly
//      either way, and any test written against status/method/body alone passes on
//      the unfixed code too.
//
// (2) is why the first test below asserts at the seam instead of the response: the
// invariant the guard establishes is "a rejected id never reaches fs", which is
// observable only by watching the call. The two behavioural tests that follow are
// the controls — they fail if the guard is over-applied and skips a legitimate
// transcript, which a seam assertion on its own cannot detect.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startTestServer, createThread } from '../helpers/harness.mjs';
import { sandboxSessionsDir, removeSandboxHome } from '../helpers/sandbox-home.mjs';

const sessionsDir = sandboxSessionsDir('main');

/** Run `fn` with fs.readFileSync recording every path it is handed. */
async function recordingReadFileSync(fn) {
  const original = fs.readFileSync;
  const paths = [];
  fs.readFileSync = function (target, ...rest) {
    paths.push(target);
    return original.call(this, target, ...rest);
  };
  try {
    await fn();
  } finally {
    fs.readFileSync = original;
  }
  return paths;
}

describe('context preamble', () => {
  let srv;

  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); removeSandboxHome(); });

  test('a rejected last_session_id never reaches fs.readFileSync', async () => {
    const id = await createThread(srv.api, { title: 'seam' });
    // PATCH is the second caller-supplied writer of this column, alongside import.
    const patched = await srv.api('PATCH', `/api/threads/${id}`, {
      body: { last_session_id: '../../../../etc/passwd' },
    });
    assert.equal(patched.status, 200, `patch failed: ${JSON.stringify(patched.body)}`);

    const paths = await recordingReadFileSync(async () => {
      const res = await srv.api('POST', `/api/threads/${id}/context-fill`);
      assert.equal(res.status, 200);
    });

    // sessionTranscriptPath() rejected the id and returned null. Unguarded, that
    // null is handed to fs.readFileSync and only a bare catch hides the TypeError.
    const nullish = paths.filter(p => p === null || p === undefined);
    assert.deepEqual(
      nullish, [],
      'buildContextPreamble passed a rejected (null) transcript path to fs.readFileSync',
    );
  });

  test('a traversing last_session_id falls back to a raw preamble and leaks nothing', async () => {
    const canary = path.join(sessionsDir, '..', 'CANARY-PREAMBLE.jsonl');
    fs.writeFileSync(canary, JSON.stringify({ type: 'compaction', summary: 'CANARY-LEAKED' }));

    const id = await createThread(srv.api, { title: 'traversal' });
    await srv.api('PATCH', `/api/threads/${id}`, {
      body: { last_session_id: '../CANARY-PREAMBLE' },
    });

    const res = await srv.api('POST', `/api/threads/${id}/context-fill`);
    assert.equal(res.status, 200, `context-fill failed: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.method, 'raw', 'a traversing id was resolved to a transcript');
    assert.ok(
      !res.body.preamble.includes('CANARY-LEAKED'),
      'the preamble leaked a transcript from outside the sessions directory',
    );
  });

  test('a legitimate last_session_id still produces a compaction preamble', async () => {
    // The control for both tests above: if the guard is over-applied — or
    // sessionTranscriptPath() is stubbed to always return null — this is what fails.
    fs.writeFileSync(
      path.join(sessionsDir, 'preamble-live.jsonl'),
      [
        JSON.stringify({ type: 'message', role: 'user' }),
        JSON.stringify({ type: 'compaction', summary: 'RESTORED-SUMMARY' }),
      ].join('\n'),
    );

    const id = await createThread(srv.api, { title: 'happy path' });
    await srv.api('PATCH', `/api/threads/${id}`, { body: { last_session_id: 'preamble-live' } });

    const res = await srv.api('POST', `/api/threads/${id}/context-fill`);
    assert.equal(res.status, 200, `context-fill failed: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.method, 'compaction', 'the ordinary compaction path stopped resolving');
    assert.ok(
      res.body.preamble.includes('RESTORED-SUMMARY'),
      'the compaction summary is missing from the preamble',
    );
  });
});
