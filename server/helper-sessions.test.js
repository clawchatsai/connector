import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHelperSessions, TEAM_UNSUPPORTED, isDockRow } from './helper-sessions.js';

const quiet = { info() {}, warn() {} };
function gw(handler = () => ({ ok: true })) {
  const calls = [];
  return { calls, request: async (m, p) => { calls.push({ m, p }); return handler(m, p); } };
}

test('create: sessions.create with the dock surface and the given restrictions, nothing else', async () => {
  const g = gw();
  const h = createHelperSessions({ request: g.request, gatewayVersion: () => '2026.11.6', log: quiet });
  await h.create({ key: 'agent:a:dashboard:1', agentId: 'a', label: 'A · team chat 12345678' });
  await h.create({ key: 'agent:g:dashboard:2', agentId: 'g', label: 'P · R · abcdef', permissionMode: 'guarded', toolOverrides: { deny: ['x'] }, cwd: '/w/f' });
  assert.deepEqual(g.calls.map(c => c.p), [
    { key: 'agent:a:dashboard:1', agentId: 'a', surface: 'plugin-dock', label: 'A · team chat 12345678' },
    { key: 'agent:g:dashboard:2', agentId: 'g', surface: 'plugin-dock', label: 'P · R · abcdef', permissionMode: 'guarded', toolOverrides: { deny: ['x'] }, cwd: '/w/f' },
  ]);
});

test('version gate: older than 2026.11.6 refuses before any call; newer and betas pass; unknown tries', async () => {
  for (const [v, ok] of [['2026.11.5', false], ['2026.9.7', false], ['v2026.11.6', true], ['2026.12.1-beta.2', true], ['2027.1.0', true], [null, null]]) {
    const h = createHelperSessions({ request: async () => ({}), gatewayVersion: () => v, log: quiet });
    assert.equal(h.supported(), ok, String(v));
  }
  const g = gw();
  const old = createHelperSessions({ request: g.request, gatewayVersion: () => '2026.9.7', log: quiet });
  await assert.rejects(old.create({ key: 'k', agentId: 'a' }), e => e.message === TEAM_UNSUPPORTED && e.code === 'gateway_too_old');
  assert.equal(g.calls.length, 0);
});

test('unknown version: a gateway refusing the surface property gets the update message; other errors pass through', async () => {
  const refuse = createHelperSessions({ request: async () => { throw new Error('invalid sessions.create params: must NOT have additional properties (surface)'); }, log: quiet });
  await assert.rejects(refuse.create({ key: 'k', agentId: 'a' }), new RegExp(TEAM_UNSUPPORTED.slice(0, 30)));
  const other = createHelperSessions({ request: async () => { throw new Error('label already in use: X'); }, log: quiet });
  await assert.rejects(other.create({ key: 'k', agentId: 'a', label: 'X' }), /label already in use/);
});

test('cleanUp: deletes visible rows (fenced by session id); keeps dock, missing and running rows', async () => {
  const rows = {
    vis: { key: 'vis', sessionId: 's1', label: 'A · team chat 1', createdVia: 'operator' },
    dock: { key: 'dock', sessionId: 's2', isDock: true, createdSurface: 'plugin-dock' },
    run: { key: 'run', sessionId: 's3', label: 'B', hasActiveRun: true },
    busy: { key: 'busy', sessionId: 's4', label: 'C' },
  };
  const g = gw((m, p) => (m === 'sessions.describe' ? { session: rows[p.key] || null } : { ok: true }));
  const forgot = [];
  const h = createHelperSessions({ request: g.request, log: quiet });
  const out = await h.cleanUp(['vis', 'dock', 'gone', 'run', 'busy'].map(key => ({ key, kind: 'work' })), { busy: k => k === 'busy', forget: c => forgot.push(c.key) });
  assert.deepEqual(out.deleted, [{ key: 'vis', kind: 'work', label: 'A · team chat 1' }]);
  assert.deepEqual(out.skipped.map(s => [s.key, s.why]), [['run', 'running'], ['busy', 'running']]);
  assert.deepEqual(g.calls.filter(c => c.m === 'sessions.delete').map(c => c.p), [{ key: 'vis', expectedSessionId: 's1' }]);
  assert.deepEqual(forgot, ['vis']);
});

test('cleanUp: a failed delete is reported and its lane kept', async () => {
  const g = gw(m => { if (m === 'sessions.delete') throw new Error('nope'); return { session: { key: 'k', sessionId: 's' } }; });
  const forgot = [];
  const out = await createHelperSessions({ request: g.request, log: quiet }).cleanUp([{ key: 'k', kind: 'guest' }], { forget: c => forgot.push(c) });
  assert.deepEqual([out.deleted, out.skipped.map(s => s.why), forgot], [[], ['nope'], []]);
});

test('isDockRow', () => {
  assert.equal(isDockRow({ isDock: true }), true);
  assert.equal(isDockRow({ createdSurface: 'plugin-dock' }), true);
  assert.equal(isDockRow({ createdVia: 'operator' }), false);
  assert.equal(isDockRow(null), false);
});
