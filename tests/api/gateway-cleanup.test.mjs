// Contract tests for server/gateway-cleanup.js (CLA-1314).
//
// cleanGatewaySession() and cleanGatewaySessionsByPrefix() delete entries from
// ~/.openclaw/agents/<agent>/sessions/sessions.json and unlink the .jsonl
// transcripts those entries reference. Deleting a thread reaches the first,
// deleting a workspace reaches the second.
//
// The store is per *agent* and flat across every workspace, unlike SQLite which
// is per workspace. So the load-bearing assertion here is what these functions
// leave alone: tearing down workspace B must not unlink workspace A's live
// transcript. Both functions also swallow their own errors and return null/0,
// which means a failure is silent — that contract is pinned below rather than
// assumed.
//
// HOME is redirected at a throwaway directory by helpers/sandbox-home.mjs, which
// harness.mjs imports ahead of the server and then hard-checks. Without it these
// tests would delete real sessions belonging to other agents on this machine.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startTestServer, createThread } from '../helpers/harness.mjs';
import { sandboxHome, sandboxSessionsDir } from '../helpers/sandbox-home.mjs';
import { getSessionsDirForAgent } from '../../server/config.js';
import { cleanGatewaySession, cleanGatewaySessionsByPrefix } from '../../server/gateway-cleanup.js';

const sessionsDir = sandboxSessionsDir('main');
const sessionsPath = path.join(sessionsDir, 'sessions.json');

/** Replace the whole store and mint a transcript per entry, so no test inherits another's state. */
function seedSessions(store) {
  fs.writeFileSync(sessionsPath, JSON.stringify(store, null, 2));
  for (const entry of Object.values(store)) {
    if (entry?.sessionId) {
      fs.writeFileSync(path.join(sessionsDir, `${entry.sessionId}.jsonl`), '{"role":"user"}\n');
    }
  }
}

const readSessions = () => JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
const transcriptExists = sessionId => fs.existsSync(path.join(sessionsDir, `${sessionId}.jsonl`));

describe('gateway session sandbox', () => {
  // Guard rail, asserted in the open so it shows up in the run rather than only
  // failing the import. A suite that resolved the real store would pass every
  // assertion below while destroying live data.
  test('the sessions directory under test is the sandbox, not a real ~/.openclaw', () => {
    assert.ok(sandboxHome.length > 0);
    assert.equal(getSessionsDirForAgent('main'), sessionsDir);
    assert.ok(sessionsDir.startsWith(sandboxHome), `${sessionsDir} must live under ${sandboxHome}`);
  });
});

describe('DELETE /api/threads/:id — gateway session cleanup', () => {
  let srv;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  /** The session key the server actually minted for a thread — never a hand-built one. */
  async function sessionKeyOf(id) {
    const res = await srv.api('GET', `/api/threads/${id}`);
    assert.equal(res.status, 200);
    return res.body.thread.session_key;
  }

  test('removes the sessions.json entry and unlinks the transcript', async () => {
    const id = await createThread(srv.api);
    const key = await sessionKeyOf(id);
    seedSessions({
      [key]: { sessionId: 'sess-doomed' },
      'agent:main:default:chat:bystander': { sessionId: 'sess-bystander' },
    });

    const res = await srv.api('DELETE', `/api/threads/${id}`);
    assert.equal(res.status, 200);

    const store = readSessions();
    assert.ok(!(key in store), 'the deleted thread\'s entry must be gone');
    assert.equal(transcriptExists('sess-doomed'), false, 'its .jsonl must be unlinked');

    // Same file, same agent: an unrelated key must survive the write-back.
    assert.equal(store['agent:main:default:chat:bystander'].sessionId, 'sess-bystander');
    assert.equal(transcriptExists('sess-bystander'), true);
  });

  test('a thread with no session entry is a clean no-op', async () => {
    const id = await createThread(srv.api);
    seedSessions({ 'agent:main:default:chat:unrelated': { sessionId: 'sess-unrelated' } });
    const before = fs.readFileSync(sessionsPath);

    const res = await srv.api('DELETE', `/api/threads/${id}`);
    assert.equal(res.status, 200, 'delete still succeeds without a session to clean');

    assert.deepEqual(fs.readFileSync(sessionsPath), before, 'sessions.json must be byte-identical');
    assert.equal(transcriptExists('sess-unrelated'), true);
  });
});

describe('DELETE /api/workspaces/:name — prefix session cleanup', () => {
  let srv;
  const TARGET = { 'x-workspace': 'doomed' };

  before(async () => {
    srv = await startTestServer();
    const created = await srv.api('POST', '/api/workspaces', { body: { name: 'doomed' } });
    assert.equal(created.status, 201, 'workspace setup');
  });
  after(async () => { await srv.close(); });

  test('cleans every session of the deleted workspace and none of another\'s', async () => {
    // Two threads in the workspace being deleted, one in the workspace that stays.
    const doomedA = (await srv.api('POST', '/api/threads', { headers: TARGET, body: {} })).body.thread.id;
    const doomedB = (await srv.api('POST', '/api/threads', { headers: TARGET, body: {} })).body.thread.id;
    const survivor = await createThread(srv.api);

    const keyOf = async (id, headers) =>
      (await srv.api('GET', `/api/threads/${id}`, { headers })).body.thread.session_key;
    const [keyA, keyB, keySurvivor] = [
      await keyOf(doomedA, TARGET), await keyOf(doomedB, TARGET), await keyOf(survivor),
    ];
    assert.ok(keyA.startsWith('agent:main:doomed:chat:'), `unexpected key ${keyA}`);
    assert.ok(keySurvivor.startsWith('agent:main:default:chat:'), `unexpected key ${keySurvivor}`);

    seedSessions({
      [keyA]: { sessionId: 'sess-a' },
      [keyB]: { sessionId: 'sess-b' },
      [keySurvivor]: { sessionId: 'sess-survivor' },
    });

    const res = await srv.api('DELETE', '/api/workspaces/doomed');
    assert.equal(res.status, 200);

    const store = readSessions();
    assert.deepEqual(Object.keys(store), [keySurvivor], 'only the other workspace\'s entry may remain');
    assert.equal(transcriptExists('sess-a'), false);
    assert.equal(transcriptExists('sess-b'), false);
    // The one that matters: the store is shared, so a prefix that over-matched
    // would take a live transcript another workspace still owns.
    assert.equal(transcriptExists('sess-survivor'), true, 'another workspace\'s transcript must survive');
  });
});

describe('gateway-cleanup error handling', () => {
  // Both functions wrap everything in try/catch and report "nothing cleaned"
  // rather than throwing, because they run inside delete handlers that must
  // still answer. Callers therefore cannot distinguish failure from a no-op —
  // pin the contract so it is a decision rather than an accident.
  test('a malformed sessions.json is swallowed', () => {
    fs.writeFileSync(sessionsPath, 'not json {');
    assert.equal(cleanGatewaySession('agent:main:default:chat:x'), null);
    assert.equal(cleanGatewaySessionsByPrefix('agent:main:default:chat:'), 0);
  });

  test('a missing sessions.json is swallowed', () => {
    fs.rmSync(sessionsPath, { force: true });
    assert.equal(cleanGatewaySession('agent:main:default:chat:x'), null);
    assert.equal(cleanGatewaySessionsByPrefix('agent:main:default:chat:'), 0);
  });

  test('a key present but without a sessionId is removed and reports null', () => {
    seedSessions({ 'agent:main:default:chat:keyless': {} });
    assert.equal(cleanGatewaySession('agent:main:default:chat:keyless'), null);
    assert.deepEqual(readSessions(), {}, 'the entry is still dropped from the store');
  });
});
