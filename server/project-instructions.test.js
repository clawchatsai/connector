import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { instructionsState, createProjectInstructions, registerProjectInstructions, pathsIn, missingPaths, formatInstructions } from './project-instructions.js';
import { SessionLens } from './session-lens.js';
import { createExtrasStore, MAX_INSTRUCTIONS } from './store/extras-store.js';

const allowed = { plugins: { entries: { connector: { hooks: { allowConversationAccess: true } } } } };

test('state: blocked by default, active with conversation access, off when prompt hooks are off', () => {
  assert.equal(instructionsState({}, 'connector'), 'blocked');
  assert.equal(instructionsState(undefined, 'connector'), 'blocked');
  assert.equal(instructionsState(allowed, 'connector'), 'active');
  assert.equal(instructionsState({ plugins: { entries: { connector: { hooks: { allowConversationAccess: true, allowPromptInjection: false } } } } }, 'connector'), 'off');
});

const CHAT = 'agent:main:dashboard:aaa';
const CHILD = 'agent:main:dashboard:bbb';
const GRANDCHILD = 'agent:main:subagent:ccc';
const ROOM = 'agent:main:dashboard:room';
const WORK = 'agent:main:dashboard:work';
const GUEST = 'agent:main:dashboard:guest';

function setup({ shared = false } = {}) {
  const extras = createExtrasStore(() => db);
  const db = new DatabaseSync(':memory:');
  const team = {
    isWorkKey: k => k === WORK || k === GUEST,
    roomOf: k => (k === ROOM || k === WORK ? ROOM : null),
    isGuestSession: k => k === GUEST,
  };
  const lens = new SessionLens({ broadcast() {}, extras, team, logger: { warn() {}, info() {} } });
  const top = { kind: 'direct', createdVia: 'operator' };
  lens.observe(CHAT, { ...top, category: 'Work' });
  lens.observe(CHILD, { kind: 'direct', parentSessionKey: CHAT, spawnedBy: CHAT, category: null });
  lens.observe(GRANDCHILD, { kind: 'direct', parentSessionKey: CHILD, spawnedBy: CHILD });
  lens.observe(ROOM, { ...top, category: 'Work' });
  lens.observe(WORK, { ...top, category: 'Other' });
  lens.observe(GUEST, { ...top, category: 'Work' });
  extras.setProjectStyle('Work', { instructions: '  Read ~/notes.md first.  ', instructionsShared: shared });
  return { lens, extras, src: createProjectInstructions({ lens, team, extras, logger: { warn() {} } }) };
}

test("a chat gets its project's instructions; spawned children at any depth get the top-level chat's", () => {
  const { src } = setup();
  const want = formatInstructions('Work', 'Read ~/notes.md first.');
  assert.equal(src.forTurn({ sessionKey: CHAT }), want);
  assert.equal(src.forTurn({ sessionKey: CHILD }), want);
  assert.equal(src.forTurn({ sessionKey: GRANDCHILD }), want);
});

test('team chats get them only when the project allows it; guest sessions never', () => {
  const off = setup().src;
  assert.equal(off.forTurn({ sessionKey: ROOM }), undefined);
  assert.equal(off.forTurn({ sessionKey: WORK }), undefined);
  const on = setup({ shared: true }).src;
  assert.match(on.forTurn({ sessionKey: ROOM }), /Read ~\/notes\.md/);
  assert.match(on.forTurn({ sessionKey: WORK }), /Project instructions: Work/, 'a working session uses its room\'s project');
  assert.equal(on.forTurn({ sessionKey: GUEST }), undefined);
});

test('sessions it cannot place get nothing: main, channels, cron, unknown, no project, empty text', () => {
  const { src, lens, extras } = setup();
  for (const sessionKey of ['agent:main:main', 'agent:main:discord:channel:1', 'agent:main:cron:x', 'agent:main:dashboard:unknown', '', undefined]) {
    assert.equal(src.forTurn({ sessionKey }), undefined, String(sessionKey));
  }
  lens.observe(CHAT, { kind: 'direct', createdVia: 'operator', category: null });
  assert.equal(src.forTurn({ sessionKey: CHAT }), undefined, 'moved out of the project');
  lens.observe(CHAT, { kind: 'direct', createdVia: 'operator', category: 'Work' });
  extras.setProjectStyle('Work', { instructions: '' });
  assert.equal(src.forTurn({ sessionKey: CHAT }), undefined, 'cleared');
});

test('follows a project rename and delete issued from the browser', () => {
  const { src, lens } = setup();
  lens.pending.set('r1', { method: 'sessions.groups.rename', params: { name: 'Work', to: 'Job' } });
  lens.response({ type: 'res', id: 'r1', ok: true, payload: {} });
  assert.match(src.forTurn({ sessionKey: CHAT }), /Project instructions: Job/);
  lens.pending.set('r2', { method: 'sessions.groups.delete', params: { name: 'Job' } });
  lens.response({ type: 'res', id: 'r2', ok: true, payload: {} });
  assert.equal(src.forTurn({ sessionKey: CHAT }), undefined);
});

test('fails open: a store error means no instructions, logged once per session', () => {
  const warns = [];
  const lens = { rootOf: k => k, categoryOf: () => 'Work' };
  const src = createProjectInstructions({ lens, extras: { getProjectInstructions() { throw new Error('db locked'); } }, logger: { warn: m => warns.push(m) } });
  assert.equal(src.forTurn({ sessionKey: CHAT }), undefined);
  assert.equal(src.forTurn({ sessionKey: CHAT }), undefined);
  assert.equal(warns.length, 1);
});

test('store: instructions are trimmed, capped, kept across style edits and renames', () => {
  const db = new DatabaseSync(':memory:');
  const extras = createExtrasStore(() => db);
  extras.setProjectStyle('P', { color: 'red', instructions: 'x'.repeat(MAX_INSTRUCTIONS + 50), instructionsShared: true });
  assert.equal(extras.getProjectInstructions('P').text.length, MAX_INSTRUCTIONS);
  extras.setProjectStyle('P', { color: 'blue' });
  assert.deepEqual({ ...extras.getProjectStyles().P, instructions: extras.getProjectStyles().P.instructions.length },
    { color: 'blue', icon: null, preset: null, instructions: MAX_INSTRUCTIONS, instructionsShared: true });
  extras.renameProjectStyle('P', 'Q');
  assert.equal(extras.getProjectInstructions('Q').shared, true);
  extras.setProjectStyle('Q', { instructions: null });
  assert.equal(extras.getProjectInstructions('Q'), null);
});

test('register: hook only when active; returns appendSystemContext from the live source', () => {
  const hooks = [];
  const api = { config: allowed, on: (name, fn) => hooks.push({ name, fn }) };
  let source = null;
  assert.equal(registerProjectInstructions(api, 'connector', () => source), 'active');
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].name, 'before_prompt_build');
  assert.equal(hooks[0].fn({}, { sessionKey: CHAT }), undefined, 'app not started yet');
  source = { forTurn: () => 'TEXT' };
  assert.deepEqual(hooks[0].fn({}, { sessionKey: CHAT }), { appendSystemContext: 'TEXT' });
  const none = [];
  assert.equal(registerProjectInstructions({ config: {}, on: (...a) => none.push(a) }, 'connector', () => source), 'blocked');
  assert.equal(none.length, 0);
});

test('pathsIn: real paths only', () => {
  const text = 'Read `~/repos/CLAUDE.md` → ~/repos/clawchats/CLAUDE.md, then `memory/qa/playbook.md` and ./notes/.\n'
    + 'Facts: /home/u/a/b.md:12. Not paths: client/server, `origin/main`, /next/, /approve, /next/<slot>/, https://x.io/a/b, `npm test`.';
  assert.deepEqual(pathsIn(text).sort(), ['./notes/', '/home/u/a/b.md', 'memory/qa/playbook.md', '~/repos/CLAUDE.md', '~/repos/clawchats/CLAUDE.md'].sort());
});

test('missingPaths: resolves ~ and workspace-relative paths', () => {
  const have = new Set(['/h/repos/CLAUDE.md', '/ws/memory/qa/playbook.md']);
  const missing = missingPaths('~/repos/CLAUDE.md ~/gone.md `memory/qa/playbook.md` `memory/nope.md`', { workspaceDir: '/ws', home: '/h', exists: p => have.has(p) });
  assert.deepEqual(missing, ['~/gone.md', 'memory/nope.md']);
});
