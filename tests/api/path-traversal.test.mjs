// Path-traversal contract tests for the two session-store path builders (CLA-1496).
//
// Both inputs below are caller-supplied and both reach path.join():
//
//   - `last_session_id`, stored verbatim by POST /api/import, is interpolated into
//     `${id}.jsonl` by DELETE /api/threads/:id and by buildContextPreamble().
//   - the agent segment of `session_key` ([^:]+ in parseSessionKey, so `/` and `..`
//     are admitted) is handed straight to getSessionsDirForAgent().
//
// Neither is a regression from PR #15 — that change narrowed which keys import will
// honour, it did not sanitise them. The fix belongs here, at the path builders,
// because four call sites resolve a directory from the agent segment and three
// build a `.jsonl` filename.
//
// The canaries live inside the sandboxed HOME (helpers/sandbox-home.mjs), so a
// traversal that still works destroys a fixture rather than a real transcript.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startTestServer } from '../helpers/harness.mjs';
import { sandboxHome, sandboxSessionsDir, removeSandboxHome } from '../helpers/sandbox-home.mjs';

const sessionsDir = sandboxSessionsDir('main');

describe('session store path traversal', () => {
  let srv;

  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); removeSandboxHome(); });

  test('DELETE /api/threads/:id cannot unlink outside the sessions directory', async () => {
    const canary = path.join(sandboxHome, 'CANARY-DELETE.jsonl');
    fs.writeFileSync(canary, 'do not delete me');

    // `../CANARY-DELETE` resolves out of <sandbox>/.openclaw/agents/main/sessions
    // into <sandbox> once the `.jsonl` suffix is appended.
    const escape = path.relative(sessionsDir, path.join(sandboxHome, 'CANARY-DELETE'));
    const imported = await srv.api('POST', '/api/import', {
      body: { threads: [{ id: 'trav-delete', title: 'x', last_session_id: escape }] },
    });
    assert.equal(imported.status, 200, `import failed: ${JSON.stringify(imported.body)}`);

    const deleted = await srv.api('DELETE', '/api/threads/trav-delete');
    assert.equal(deleted.status, 200);

    assert.ok(
      fs.existsSync(canary),
      'thread delete followed ../ out of the sessions directory and unlinked an arbitrary .jsonl',
    );
  });

  test('a traversing agent segment does not resolve a sessions directory outside the store', async () => {
    const escape = path.relative(path.join(sandboxHome, '.openclaw', 'agents'), sandboxHome);
    const { getSessionsDirForAgent } = await import('../../server/config.js');
    const resolved = path.resolve(getSessionsDirForAgent(escape));

    assert.ok(
      resolved.startsWith(path.join(sandboxHome, '.openclaw', 'agents') + path.sep),
      `agent segment "${escape}" resolved to ${resolved}, outside ~/.openclaw/agents`,
    );
  });

  test('cleanGatewaySession cannot be steered out of the store by an agent segment', async () => {
    // `path.join(HOME, '.openclaw', 'agents', '../..', 'sessions')` lands on
    // <sandbox>/sessions, so that is where the traversal's store and canary go.
    // Planting them anywhere else makes this test pass without ever arming it.
    const escape = '../..';
    const escapedDir = path.join(sandboxHome, 'sessions');
    fs.mkdirSync(escapedDir, { recursive: true });
    const canary = path.join(escapedDir, 'CANARY-CLEAN.jsonl');
    fs.writeFileSync(canary, 'do not delete me');
    const key = `agent:${escape}:main:chat:trav-clean`;
    fs.writeFileSync(
      path.join(escapedDir, 'sessions.json'),
      JSON.stringify({ [key]: { sessionId: 'CANARY-CLEAN' } }),
    );

    const { cleanGatewaySession } = await import('../../server/gateway-cleanup.js');
    cleanGatewaySession(key);

    assert.ok(
      fs.existsSync(canary),
      'cleanGatewaySession followed the agent segment out of ~/.openclaw/agents and unlinked a canary',
    );
  });

  test('a legitimate agent segment still resolves to that agent’s sessions directory', async () => {
    const { getSessionsDirForAgent } = await import('../../server/config.js');
    assert.equal(
      getSessionsDirForAgent('worker_2'),
      path.join(sandboxHome, '.openclaw', 'agents', 'worker_2', 'sessions'),
    );
    assert.equal(getSessionsDirForAgent('main'), sessionsDir);
    assert.equal(getSessionsDirForAgent(undefined), sessionsDir);
  });

  test('a legitimate last_session_id is still unlinked on delete', async () => {
    const live = path.join(sessionsDir, 'live-session-1.jsonl');
    fs.writeFileSync(live, '{}');

    const imported = await srv.api('POST', '/api/import', {
      body: { threads: [{ id: 'trav-control', title: 'x', last_session_id: 'live-session-1' }] },
    });
    assert.equal(imported.status, 200, `import failed: ${JSON.stringify(imported.body)}`);
    await srv.api('DELETE', '/api/threads/trav-control');

    assert.ok(!fs.existsSync(live), 'the ordinary delete path stopped removing its own transcript');
  });
});
