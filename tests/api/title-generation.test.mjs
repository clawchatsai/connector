// Contract tests for AI title generation across workspaces (CLA-1310).
//
// generateThreadTitle() parks an entry in _pendingTitleGens keyed by a string that
// is also sent to the gateway as the session key, and handleTitleResponse() looks
// the reply back up by that key. The parked value carries the workspace whose
// database the title is written into, so a key that two workspaces can both mint —
// or a lookup that can land on the wrong entry — is a cross-workspace write.
//
// Thread ids are not unique across workspaces: POST /api/threads and POST /api/import
// both accept a caller-supplied id, so the same id genuinely lives in two workspaces.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from '../helpers/harness.mjs';

/** Stand up a thread with enough history that generateThreadTitle() dials the gateway. */
async function seedThread(srv, workspace, id) {
  const headers = { 'x-workspace': workspace };
  const created = await srv.api('POST', '/api/threads', { headers, body: { id } });
  assert.equal(created.status, 201, `thread setup for ${workspace}/${id}`);
  for (const [n, role] of [[1, 'user'], [2, 'assistant']]) {
    const res = await srv.api('POST', `/api/threads/${id}/messages`, {
      headers,
      body: { id: `${workspace}-${id}-m${n}`, role, content: `${role} message in ${workspace}`, timestamp: Date.now() + n },
    });
    assert.equal(res.status, 201, `message setup for ${workspace}/${id}`);
  }
}

/** The gateway echoes the title session key back prefixed with the agent it ran under. */
function echoTitle(srv, sessionKey, title) {
  srv.app.gatewayClient.handleChatEvent(
    { sessionKey: `agent:main:${sessionKey}`, state: 'final', message: { content: title } },
    JSON.stringify({ type: 'event', event: 'chat' }),
  );
}

async function titleOf(srv, workspace, id) {
  const res = await srv.api('GET', `/api/threads/${id}`, { headers: { 'x-workspace': workspace } });
  assert.equal(res.status, 200, `thread ${id} must exist in ${workspace}`);
  return res.body.thread.title;
}

describe('title generation is scoped to the requesting workspace', () => {
  let srv;
  let sent;

  before(async () => {
    srv = await startTestServer();
    for (const name of ['alpha', 'beta']) {
      const res = await srv.api('POST', '/api/workspaces', { body: { name } });
      assert.equal(res.status, 201, `workspace setup for ${name}`);
    }
  });
  after(async () => { await srv.close(); });

  // The gateway is never dialled in tests, so capture the frames instead of sending them.
  beforeEach(() => {
    sent = [];
    srv.app.gatewayClient.sendToGateway = data => sent.push(JSON.parse(data));
    srv.app.gatewayClient._pendingTitleGens.clear();
  });

  test('the same thread id in two workspaces generates two titles', async () => {
    await seedThread(srv, 'alpha', 'dup-1');
    await seedThread(srv, 'beta', 'dup-1');

    await srv.api('POST', '/api/threads/dup-1/generate-title', { headers: { 'x-workspace': 'alpha' } });
    await srv.api('POST', '/api/threads/dup-1/generate-title', { headers: { 'x-workspace': 'beta' } });

    // An unqualified key makes the second request collide with the first and return
    // early, so beta's title is never requested at all.
    assert.equal(sent.length, 2, 'both workspaces must reach the gateway');
    const keys = sent.map(f => f.params.sessionKey);
    assert.notEqual(keys[0], keys[1], 'the title session key must distinguish the two workspaces');
    assert.equal(srv.app.gatewayClient._pendingTitleGens.size, 2);
  });

  test('a reply is written to the workspace that asked for it', async () => {
    await seedThread(srv, 'alpha', 'dup-2');
    await seedThread(srv, 'beta', 'dup-2');

    await srv.api('POST', '/api/threads/dup-2/generate-title', { headers: { 'x-workspace': 'alpha' } });
    await srv.api('POST', '/api/threads/dup-2/generate-title', { headers: { 'x-workspace': 'beta' } });
    assert.equal(sent.length, 2, 'precondition: both requests were sent');

    const betaKey = sent[1].params.sessionKey;
    const alphaTitleBefore = await titleOf(srv, 'alpha', 'dup-2');
    echoTitle(srv, betaKey, 'Beta Generated Title');

    assert.equal(await titleOf(srv, 'beta', 'dup-2'), 'Beta Generated Title');
    assert.equal(await titleOf(srv, 'alpha', 'dup-2'), alphaTitleBefore,
      'alpha holds the same thread id and must not be written to');
  });

  test('a thread id that prefixes another is not mistaken for it', async () => {
    // Caller-supplied ids mean one pending key can be a strict prefix of another, and
    // the reply is matched by substring. Taking the first hit in insertion order picks
    // the shorter, wrong entry.
    await seedThread(srv, 'alpha', 'pre');
    await seedThread(srv, 'alpha', 'pre-longer');

    await srv.api('POST', '/api/threads/pre/generate-title', { headers: { 'x-workspace': 'alpha' } });
    await srv.api('POST', '/api/threads/pre-longer/generate-title', { headers: { 'x-workspace': 'alpha' } });
    assert.equal(sent.length, 2, 'precondition: both requests were sent');

    const shortTitleBefore = await titleOf(srv, 'alpha', 'pre');
    echoTitle(srv, sent[1].params.sessionKey, 'Longer Thread Title');

    assert.equal(await titleOf(srv, 'alpha', 'pre-longer'), 'Longer Thread Title');
    assert.equal(await titleOf(srv, 'alpha', 'pre'), shortTitleBefore,
      'the reply belongs to the longer id that produced it');
  });
});
