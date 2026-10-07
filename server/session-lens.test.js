import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionLens, isCandidateKey, trimRow } from './session-lens.js';

const CHAT = 'agent:main:dashboard:abc';
const LEGACY = 'agent:main:proxmox:chat:1234';
const CHILD = 'agent:main:dashboard:child1';
const DISCORD = 'agent:main:discord:channel:99';

function lens(extras) {
  const sent = [];
  const l = new SessionLens({ broadcast: d => sent.push(JSON.parse(d)), extras, logger: { info() {}, warn() {} } });
  return { l, sent };
}

test('key shapes', () => {
  assert.ok(isCandidateKey(CHAT));
  assert.ok(isCandidateKey(LEGACY));
  for (const k of [DISCORD, 'agent:main:main', 'agent:main:cron:x', 'agent:main:recovered:x', 'agent:main:__clawchats_summarizer', 'agent:main:x:chat:__clawchats_title_1', 'agent:main:node-1'])
    assert.equal(isCandidateKey(k), false, k);
});

test('a child of an unresolved parent stays hidden, even for partial events', () => {
  const { l } = lens();
  assert.equal(l.sessionsChanged({ sessionKey: CHILD, reason: 'create', parentSessionKey: CHAT, label: 'x' }), null);
  assert.equal(l.sessionsChanged({ sessionKey: CHILD, phase: 'message', ts: 1 }), null);
  assert.equal(l.forwardsRunEvent(CHILD), false);
});

test('visible change is trimmed; catalog events pass', () => {
  const { l } = lens();
  const f = l.sessionsChanged({ sessionKey: CHAT, reason: 'patch', ts: 5, label: 'Hi', category: 'Default', participants: [1, 2], swarm: {}, session: { key: CHAT, label: 'Hi', owner: {}, thinkingOptions: [] } });
  assert.deepEqual(f.payload, { sessionKey: CHAT, reason: 'patch', ts: 5, label: 'Hi', category: 'Default', session: { key: CHAT, label: 'Hi' } });
  assert.equal(l.sessionsChanged({ sessionKey: DISCORD, reason: 'send', channel: 'discord' }), null);
  assert.deepEqual(l.sessionsChanged({ reason: 'groups', ts: 1 }).payload, { reason: 'groups', ts: 1 });
});

test('run events: visible chats and utility sessions only', () => {
  const { l } = lens();
  assert.ok(l.forwardsRunEvent(CHAT));
  assert.ok(l.forwardsRunEvent('agent:main:__clawchats_semantic'));
  assert.ok(l.forwardsRunEvent('agent:main:__clawchats_title_42'));
  assert.equal(l.forwardsRunEvent(DISCORD), false);
  assert.equal(l.forwardsRunEvent('agent:main:main'), false);
});

test('browser sessions.list gets defaults and a filtered, trimmed response', () => {
  const { l } = lens();
  const out = JSON.parse(l.outbound(JSON.stringify({ type: 'req', id: 'r1', method: 'sessions.list', params: { limit: 50 } })));
  assert.deepEqual(out.params, { excludeSubagents: false, excludeCron: true, excludeSystem: true, limit: 50 });
  assert.ok(l.ownsResponse('r1'));
  const res = l.response({ type: 'res', id: 'r1', ok: true, payload: {
    ts: 1, count: 4, totalCount: 4, hasMore: false, nextOffset: null, owners: [{}],
    sessions: [
      { key: CHAT, label: 'a', owner: {}, classification: 'direct' },
      { key: LEGACY, label: 'b', classification: 'direct' },
      { key: CHILD, parentSessionKey: CHAT, classification: 'direct' },
      { key: DISCORD, classification: 'channel' },
    ] } });
  assert.deepEqual(res.payload.sessions.map(s => s.key), [CHAT, LEGACY]);
  assert.equal(res.payload.count, 2);
  assert.equal('owners' in res.payload, false);
  assert.equal('owner' in res.payload.sessions[0], false);
  assert.equal(l.ownsResponse('r1'), false);
});

test('bare sessions.subscribe passes untouched; subscribe-with-list is filtered', () => {
  const { l } = lens();
  const bare = JSON.stringify({ type: 'req', id: 's0', method: 'sessions.subscribe', params: {} });
  assert.equal(l.outbound(bare), bare);
  l.outbound(JSON.stringify({ type: 'req', id: 's1', method: 'sessions.subscribe', params: { limit: 10 } }));
  const res = l.response({ type: 'res', id: 's1', ok: true, payload: { subscribed: true, list: { sessions: [{ key: CHAT }, { key: DISCORD }] } } });
  assert.deepEqual(res.payload.list.sessions.map(s => s.key), [CHAT]);
});

test('sessions.unsubscribe from a browser is answered locally', () => {
  const { l, sent } = lens();
  assert.equal(l.outbound(JSON.stringify({ type: 'req', id: 'u1', method: 'sessions.unsubscribe' })), null);
  assert.deepEqual(sent[0], { type: 'res', id: 'u1', ok: true, payload: { subscribed: true } });
});

test('search results are limited to visible sessions', () => {
  const { l } = lens();
  l.outbound(JSON.stringify({ type: 'req', id: 'q', method: 'sessions.search', params: { query: 'x' } }));
  const res = l.response({ type: 'res', id: 'q', ok: true, payload: { results: [{ sessionKey: CHAT }, { sessionKey: DISCORD }], sessions: [{ key: CHAT }, { key: DISCORD }] } });
  assert.deepEqual(res.payload.results, [{ sessionKey: CHAT }]);
  assert.deepEqual(res.payload.sessions, [{ key: CHAT }]);
});

test('group rename/delete move project styles only on success', () => {
  const calls = [];
  const extras = { renameProjectStyle: (a, b) => calls.push(['rename', a, b]), deleteProjectStyle: a => calls.push(['delete', a]), deleteThreadExtras: k => calls.push(['thread', k]) };
  const { l } = lens(extras);
  l.outbound(JSON.stringify({ type: 'req', id: 'g1', method: 'sessions.groups.rename', params: { name: 'A', to: 'B' } }));
  l.outbound(JSON.stringify({ type: 'req', id: 'g2', method: 'sessions.groups.delete', params: { name: 'C' } }));
  l.outbound(JSON.stringify({ type: 'req', id: 'g3', method: 'sessions.groups.delete', params: { name: 'D' } }));
  l.response({ type: 'res', id: 'g1', ok: true, payload: {} });
  l.response({ type: 'res', id: 'g2', ok: true, payload: {} });
  l.response({ type: 'res', id: 'g3', ok: false, error: { message: 'nope' } });
  l.sessionsChanged({ sessionKey: CHAT, reason: 'delete' });
  assert.deepEqual(calls, [['rename', 'A', 'B'], ['delete', 'C'], ['thread', CHAT]]);
});

test('trimRow keeps only allow-listed fields', () => {
  assert.deepEqual(trimRow({ key: 'k', unread: true, participants: [], thinkingOptions: [] }), { key: 'k', unread: true });
});

test('chat.history passes through untouched (gateway enforces maxBytes)', () => {
  const { l } = lens();
  const f = JSON.stringify({ type: 'req', id: 'h', method: 'chat.history', params: { sessionKey: CHAT, limit: 80, maxBytes: 262144 } });
  assert.equal(l.outbound(f), f);
  assert.equal(l.ownsResponse('h'), false);
});

test('operator roots linked to the main session are visible; real children are not', () => {
  const { l } = lens();
  assert.ok(l.sessionsChanged({ sessionKey: CHAT, reason: 'create', parentSessionKey: 'agent:main:main', spawnDepth: 0, category: 'test' }));
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:k1', reason: 'create', parentSessionKey: 'agent:main:main', spawnedBy: 'agent:main:main' }), null);
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:k2', reason: 'create', parentSessionKey: CHAT }), null);
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:k3', reason: 'create', parentSessionKey: 'agent:main:main', spawnDepth: 1 }), null);
});

test('Control UI rule: classification ignored, kind/provenance decide, full rows can un-hide', () => {
  const { l } = lens();
  assert.ok(l.sessionsChanged({ sessionKey: CHAT, reason: 'create', classification: 'dashboard', parentSessionKey: 'agent:main:main', spawnDepth: 0 }));
  const K = 'agent:main:dashboard:flip';
  assert.equal(l.sessionsChanged({ sessionKey: K, reason: 'x', kind: 'group' }), null);
  assert.ok(l.sessionsChanged({ sessionKey: K, reason: 'patch', kind: 'direct', createdVia: 'operator', parentSessionKey: 'agent:main:main', spawnDepth: 0 }));
  // legacy main-linked row without operator provenance nests under Home
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:old', reason: 'patch', kind: 'direct', parentSessionKey: 'agent:main:main' }), null);
  // system-created probe without a name
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:probe', reason: 'create', kind: 'direct', createdVia: 'internal' }), null);
  // coding sessions
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:wt', reason: 'create', kind: 'direct', worktree: { id: 'w' } }), null);
});

test('forks of chats are chats (edit/regen branches)', () => {
  const { l } = lens();
  // fork of a legacy top-level chat: no parent
  assert.ok(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:f1', reason: 'create', kind: 'direct', forkSource: { sessionKey: LEGACY, sessionId: 's' } }));
  // fork of a dashboard chat: inherits the main link
  assert.ok(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:f2', reason: 'create', kind: 'direct', createdVia: 'operator', parentSessionKey: 'agent:main:main', spawnDepth: 0, forkSource: { sessionKey: CHAT, sessionId: 's' } }));
  // a fork nested under another chat is still a child: shown nested under that chat
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:f3', reason: 'create', kind: 'direct', parentSessionKey: CHAT, forkSource: { sessionKey: LEGACY, sessionId: 's' } }).payload.ccParentKey, CHAT); // parent is not the fork source
});

test('sessions.fork branches (parent = source chat) are top-level chats', () => {
  const { l } = lens();
  const SRC = 'agent:main:dashboard:src';
  assert.ok(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:br', reason: 'create', kind: 'direct', createdVia: 'operator', parentSessionKey: SRC, forkedFromParent: true, forkSource: { sessionKey: SRC, sessionId: 's', entryId: 'e' } }));
  assert.ok(l.forwardsRunEvent('agent:main:dashboard:br'));
  // a child whose parent is a chat but that is not a fork of it stays nested
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:kid', reason: 'create', kind: 'direct', parentSessionKey: SRC }).payload.ccParentKey, SRC);
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:br', reason: 'patch', label: 'x' }).payload.ccParentKey, undefined); // the branch itself is top level
  // fork of a channel session is not a chat
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:dashboard:br2', reason: 'create', kind: 'direct', parentSessionKey: DISCORD, forkSource: { sessionKey: DISCORD } }), null);
});

test('session.message only for chats a browser subscribed to', () => {
  const { l } = lens();
  const msg = { sessionKey: CHAT, message: { role: 'assistant', content: [] }, messageId: 'm', participants: [1] };
  assert.equal(l.sessionMessage(msg), null);
  l.outbound(JSON.stringify({ type: 'req', id: 's', method: 'sessions.messages.subscribe', params: { key: CHAT, subscriptionId: 'tab1' } }));
  const f = l.sessionMessage(msg);
  assert.deepEqual(f.payload, { sessionKey: CHAT, message: msg.message, messageId: 'm' });
  assert.equal(l.sessionMessage({ ...msg, sessionKey: DISCORD }), null);
  l.outbound(JSON.stringify({ type: 'req', id: 'u', method: 'sessions.messages.unsubscribe', params: { key: CHAT, subscriptionId: 'tab1' } }));
  assert.equal(l.sessionMessage(msg), null);
});

test('listed rows without createdAt get the legacy creation time; gateway values win', () => {
  const extras = { getLegacyCreatedAt: () => new Map([[LEGACY, 111], [CHAT, 222]]) };
  const { l } = lens(extras);
  l.outbound(JSON.stringify({ type: 'req', id: 'c1', method: 'sessions.list', params: {} }));
  const res = l.response({ type: 'res', id: 'c1', ok: true, payload: { sessions: [
    { key: LEGACY, label: 'old', kind: 'direct' },
    { key: CHAT, label: 'new', kind: 'direct', createdAt: 999 },
  ] } });
  assert.deepEqual(res.payload.sessions.map(s => s.createdAt), [111, 999]);
});

const RUN = 'agent:main:subagent:run1';

test('spawned children of a visible chat are visible, nested via ccParentKey', () => {
  const { l } = lens();
  l.observe(CHAT, { key: CHAT, kind: 'direct', createdVia: 'operator', parentSessionKey: 'agent:main:main', spawnDepth: 0 });
  // hidden run (subagent key)
  const f = l.sessionsChanged({ sessionKey: RUN, reason: 'create', session: { key: RUN, kind: 'direct', spawnedBy: CHAT, parentSessionKey: CHAT, spawnDepth: 1, label: 'Review', owner: {} } });
  assert.deepEqual(f.payload.session, { key: RUN, kind: 'direct', label: 'Review', ccParentKey: CHAT });
  // later partial events keep the link
  assert.equal(l.sessionsChanged({ sessionKey: RUN, phase: 'message', ts: 2 }).payload.ccParentKey, CHAT);
  assert.ok(l.forwardsRunEvent(RUN));
  // visible spawn (dashboard key)
  const V = 'agent:main:dashboard:vis';
  assert.ok(l.sessionsChanged({ sessionKey: V, reason: 'create', kind: 'direct', createdVia: 'spawn', spawnedBy: CHAT, parentSessionKey: CHAT, spawnDepth: 1 }));
  assert.equal(l.parentOf(V), CHAT);
  // grandchild through a run
  const G = 'agent:main:subagent:run2';
  assert.equal(l.sessionsChanged({ sessionKey: G, reason: 'create', kind: 'direct', spawnedBy: RUN, spawnDepth: 2 }).payload.ccParentKey, RUN);
});

test('children outside ClawChats chats stay hidden', () => {
  const { l } = lens();
  assert.equal(l.sessionsChanged({ sessionKey: RUN, reason: 'create', kind: 'direct', spawnedBy: 'agent:main:main', parentSessionKey: 'agent:main:main', spawnDepth: 1 }), null);
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:subagent:d', reason: 'create', kind: 'direct', spawnedBy: DISCORD, spawnDepth: 1 }), null);
  assert.equal(l.forwardsRunEvent(RUN), false);
  // parent chat hidden (e.g. group kind) -> its children too
  l.observe(CHAT, { key: CHAT, kind: 'group' });
  assert.equal(l.sessionsChanged({ sessionKey: 'agent:main:subagent:e', reason: 'create', kind: 'direct', spawnedBy: CHAT, spawnDepth: 1 }), null);
  // a cycle never resolves
  l.observe('agent:main:subagent:x', { kind: 'direct', spawnedBy: 'agent:main:subagent:y' });
  l.observe('agent:main:subagent:y', { kind: 'direct', spawnedBy: 'agent:main:subagent:x' });
  assert.equal(l.parentOf('agent:main:subagent:x'), null);
});

test('list responses keep children whose parent is listed later on the page', () => {
  const { l } = lens();
  l.outbound(JSON.stringify({ type: 'req', id: 'c1', method: 'sessions.list', params: {} }));
  const res = l.response({ type: 'res', id: 'c1', ok: true, payload: { sessions: [
    { key: RUN, kind: 'direct', spawnedBy: CHAT, parentSessionKey: CHAT, spawnDepth: 1, label: 'r', runtimeMs: 5, startedAt: 1 },
    { key: CHAT, kind: 'direct', createdVia: 'operator', parentSessionKey: 'agent:main:main', spawnDepth: 0, label: 'c' },
    { key: 'agent:main:subagent:other', kind: 'direct', spawnedBy: 'agent:main:main', spawnDepth: 1 },
  ] } });
  assert.deepEqual(res.payload.sessions, [
    { key: RUN, kind: 'direct', label: 'r', runtimeMs: 5, startedAt: 1, ccParentKey: CHAT },
    { key: CHAT, kind: 'direct', label: 'c' },
  ]);
});

test('a patched session tells the team coordinator (a renamed room reaches its copies)', async () => {
  const patched = [];
  const { l } = lens({});
  l.team = { isWorkKey: () => false, onSessionPatched: async key => { patched.push(key); } };
  l.sessionsChanged({ sessionKey: CHAT, reason: 'patch', label: 'New name' });
  assert.deepEqual(patched, [CHAT]);
});
