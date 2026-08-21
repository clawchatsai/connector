// CLA-1503 — a thread must not be able to reach a transcript it does not own.
//
// `last_session_id` is the only thread column that names a file in the gateway
// session store, and it is entirely client-maintained: `git grep last_session_id
// server/` finds the schema, two caller-supplied writers (POST /api/import and
// PATCH /api/threads/:id) and two readers (DELETE /api/threads/:id and
// buildContextPreamble). Nothing server-side ever writes it — the reconcile
// endpoint that was meant to, per specs/backend-session-architecture.md
// ("Session Reset Detection"), was never built.
//
// CLA-1496 stopped the value *escaping* the store. It stayed able to name any
// transcript *inside* it, which is worse than a same-workspace collision sounds:
// the store is resolved per *agent* and is global across workspaces
// (getSessionsDirForAgent), while the databases are per workspace. So a session id
// reaches another workspace's live transcript, crossing the boundary the rest of
// the session-key handling exists to enforce.
//
// Both halves are covered because closing only the delete leaves the read open:
// the same column also picks which transcript buildContextPreamble() parses, and
// its compaction summary is returned to the caller in the response body.
//
// The canaries live inside the sandboxed HOME (helpers/sandbox-home.mjs), so a
// regression destroys a fixture rather than a real transcript.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startTestServer, createThread } from '../helpers/harness.mjs';
import { sandboxSessionsDir, removeSandboxHome } from '../helpers/sandbox-home.mjs';

const sessionsDir = sandboxSessionsDir('main');

/** Plant a transcript another thread owns, and return its path. */
function plantVictimTranscript(sessionId, contents = '{"type":"message"}') {
  const file = path.join(sessionsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, contents);
  return file;
}

describe('caller-supplied last_session_id (CLA-1503)', () => {
  let srv;

  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); removeSandboxHome(); });

  test('DELETE does not unlink a transcript named by an imported last_session_id', async () => {
    const victim = plantVictimTranscript('victim-import');

    const imported = await srv.api('POST', '/api/import', {
      body: { threads: [{ id: 'own-import', title: 'x', last_session_id: 'victim-import' }] },
    });
    assert.equal(imported.status, 200, `import failed: ${JSON.stringify(imported.body)}`);

    const deleted = await srv.api('DELETE', '/api/threads/own-import');
    assert.equal(deleted.status, 200);

    assert.ok(
      fs.existsSync(victim),
      'deleting an imported thread unlinked a transcript named only by its caller-supplied last_session_id',
    );
  });

  test('DELETE does not unlink a transcript named by a PATCHed last_session_id', async () => {
    const victim = plantVictimTranscript('victim-patch');
    const id = await createThread(srv.api);

    const patched = await srv.api('PATCH', `/api/threads/${id}`, {
      body: { last_session_id: 'victim-patch' },
    });
    assert.equal(patched.status, 200);

    const deleted = await srv.api('DELETE', `/api/threads/${id}`);
    assert.equal(deleted.status, 200);

    assert.ok(
      fs.existsSync(victim),
      'deleting a thread unlinked a transcript named only by a PATCHed last_session_id',
    );
  });

  test('context-fill does not read a transcript named by a caller-supplied last_session_id', async () => {
    // The compaction summary is the payload: buildContextPreamble() returns it in
    // the response body, so honouring the column here discloses another
    // workspace's conversation, not just its filename.
    plantVictimTranscript(
      'victim-preamble',
      JSON.stringify({ type: 'compaction', summary: 'SECRET-FROM-ANOTHER-WORKSPACE' }),
    );

    const imported = await srv.api('POST', '/api/import', {
      body: {
        threads: [{
          id: 'own-preamble',
          title: 'x',
          last_session_id: 'victim-preamble',
          messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: Date.now() }],
        }],
      },
    });
    assert.equal(imported.status, 200, `import failed: ${JSON.stringify(imported.body)}`);

    const filled = await srv.api('POST', '/api/threads/own-preamble/context-fill');
    assert.equal(filled.status, 200);
    assert.ok(
      !filled.body.preamble.includes('SECRET-FROM-ANOTHER-WORKSPACE'),
      'context-fill returned the compaction summary of a transcript the thread does not own',
    );
    assert.equal(filled.body.method, 'raw');
  });

  // The seam behind all three. The two behavioural tests above would also pass if
  // only the readers were changed, leaving a client-chosen filename sitting in the
  // column for the next reader that is added; this is the invariant that stops
  // that — the value is never persisted in the first place.
  test('neither writer persists a caller-supplied last_session_id', async () => {
    const imported = await srv.api('POST', '/api/import', {
      body: { threads: [{ id: 'seam-import', title: 'x', last_session_id: 'anything-at-all' }] },
    });
    assert.equal(imported.status, 200);
    const afterImport = await srv.api('GET', '/api/threads/seam-import');
    assert.equal(afterImport.body.thread.last_session_id, null);

    const id = await createThread(srv.api);
    const patched = await srv.api('PATCH', `/api/threads/${id}`, {
      body: { last_session_id: 'anything-at-all' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.thread.last_session_id, null);
  });

  // Controls. Refusing the column is only correct if the thread's *own* transcript
  // is still cleaned up and the two writers still write everything else — a fix
  // that broke either would pass every assertion above.

  test('a thread whose session the store owns still has its transcript unlinked on delete', async () => {
    const id = await createThread(srv.api);
    const { session_key: sessionKey } = (await srv.api('GET', `/api/threads/${id}`)).body.thread;

    const own = path.join(sessionsDir, 'own-session.jsonl');
    fs.writeFileSync(own, '{}');
    const storePath = path.join(sessionsDir, 'sessions.json');
    fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: { sessionId: 'own-session' } }));

    const deleted = await srv.api('DELETE', `/api/threads/${id}`);
    assert.equal(deleted.status, 200);

    assert.ok(!fs.existsSync(own), 'delete stopped removing the transcript the store associates with the thread');
    assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), {}, 'delete stopped removing the store entry');
  });

  test('PATCH still applies its other fields alongside a rejected last_session_id', async () => {
    const id = await createThread(srv.api);
    const patched = await srv.api('PATCH', `/api/threads/${id}`, {
      body: { title: 'renamed', model: 'sonnet', pinned: true, last_session_id: 'ignored' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.thread.title, 'renamed');
    assert.equal(patched.body.thread.model, 'sonnet');
    assert.equal(patched.body.thread.pinned, 1);
  });

  test('import still imports its other fields alongside a rejected last_session_id', async () => {
    const imported = await srv.api('POST', '/api/import', {
      body: {
        threads: [{
          id: 'control-import',
          title: 'Imported title',
          model: 'opus',
          pinned: 1,
          last_session_id: 'ignored',
          messages: [{ id: 'cm1', role: 'user', content: 'hello', timestamp: 1 }],
        }],
      },
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.threadsImported, 1);
    assert.equal(imported.body.messagesImported, 1);

    const { thread } = (await srv.api('GET', '/api/threads/control-import')).body;
    assert.equal(thread.title, 'Imported title');
    assert.equal(thread.model, 'opus');
    assert.equal(thread.pinned, 1);
  });
});
