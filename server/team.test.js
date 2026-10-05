import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from './bootstrap/native.js';
import { createTeamStore } from './store/team-store.js';
import { TeamCoordinator, parseMentions, namedIn, splitLabel, entryId } from './team.js';
import { SessionLens } from './session-lens.js';

const AGENTS = [{ id: 'main', identity: {} }, { id: 'dev', identity: { name: 'Dev' } }, { id: 'atlas', identity: { name: 'Atlas' } }];

/** Fake gateway. `reply(agentId, prompt)` returns the agent's reply text, null (abort) or a promise. */
function harness(reply, { preparedTitle = 'Team title', titler = null } = {}) {
  const sessions = new Map(); // key -> [{ role, content, timestamp, __m: { id } }]
  const calls = [];
  let clock = 1_000, seq = 0;
  const events = [];
  let team;
  const request = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case 'agents.list': return { agents: AGENTS };
      case 'sessions.create': sessions.set(params.key, []); return { ok: true, key: params.key };
      case 'sessions.describe': return { session: { key: params.key } };
      case 'sessions.title.prepare': return { title: preparedTitle };
      case 'sessions.patch': case 'sessions.delete': return { ok: true };
      case 'chat.inject': {
        const id = `m${++seq}`;
        sessions.get(params.sessionKey).push({ role: 'assistant', content: [{ type: 'text', text: `[${params.label}]\n\n${params.message}` }], timestamp: ++clock, __m: { id } });
        return { ok: true, messageId: id };
      }
      case 'chat.history': return { messages: (sessions.get(params.sessionKey) || []).slice(-(params.limit || 80)) };
      case 'chat.send': {
        sessions.get(params.sessionKey).push({ role: 'user', content: params.message, timestamp: ++clock, __m: { id: `u${++seq}` } });
        const agentId = /^agent:([^:]+):/.exec(params.sessionKey)[1];
        const runId = params.idempotencyKey;
        Promise.resolve(reply(agentId, params.message)).then(text => {
          if (text && typeof text === 'object') { // { partial, state }: streamed some text, then aborted/error
            team.onGatewayEvent({ type: 'event', event: 'chat', payload: { runId, sessionKey: params.sessionKey, state: 'delta', message: { role: 'assistant', content: [{ type: 'text', text: text.partial }] } } });
            team.onGatewayEvent({ type: 'event', event: 'chat', payload: { runId, sessionKey: params.sessionKey, state: 'delta', deltaText: ' more' } });
            team.onGatewayEvent({ type: 'event', event: 'chat', payload: { runId, sessionKey: params.sessionKey, state: text.state, errorMessage: text.error } });
            return;
          }
          const state = text === null ? 'aborted' : 'final';
          const payload = { runId, sessionKey: params.sessionKey, state };
          if (text && text !== 'NO_REPLY') payload.message = { role: 'assistant', content: [{ type: 'text', text }] };
          team.onGatewayEvent({ type: 'event', event: 'chat', payload });
          if (text === 'NO_REPLY') team.onGatewayEvent({ type: 'event', event: 'chat', payload: { runId, sessionKey: params.sessionKey, state: 'error' } });
        });
        return { runId, status: 'started' };
      }
      case 'chat.abort': return { ok: true };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const db = new Database(':memory:');
  team = new TeamCoordinator({ store: createTeamStore(() => db), request, titler, broadcast: d => events.push(JSON.parse(d)), logger: { warn() {}, error() {} } });
  const room = key => (sessions.get(key) || []).map(m => m.content[0].text);
  const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r)); for (const c of team._chains.values()) await c; };
  return { team, calls, room, settle, events, sessions };
}

test('parsing helpers', () => {
  const agents = [{ agentId: 'main', name: 'main' }, { agentId: 'atlas', name: 'Atlas' }, { agentId: 'dev', name: 'Dev Bot' }];
  assert.deepEqual(parseMentions('hey @Atlas and @devbot.', agents), { agentIds: ['atlas', 'dev'] });
  assert.deepEqual(parseMentions('mail me at x@atlas.com', agents), { agentIds: [] });
  assert.deepEqual(parseMentions('@all thoughts?', agents), { all: true });
  assert.deepEqual(parseMentions('no mention here', agents), { agentIds: [] });
  assert.deepEqual(namedIn('I agree with Atlas, @main?', agents).sort(), ['atlas', 'main']);
  assert.deepEqual(namedIn('Atlassian is a company', agents), []);
  assert.deepEqual(splitLabel('[Atlas]\n\nhi\n\nthere'), { label: 'Atlas', body: 'hi\n\nthere' });
  assert.deepEqual(splitLabel('plain'), { label: null, body: 'plain' });
  assert.equal(entryId({ role: 'x', __meta: { id: 'e1' } }), 'e1');
});

test('create, open message: everyone asked, silent agents stay out of the room', async () => {
  const h = harness((agent, prompt) => {
    assert.match(prompt, /not addressed to anyone/);
    return agent === 'dev' ? 'dev answer' : 'NO_REPLY';
  });
  const { roomKey } = await h.team.createRoom({ agentIds: ['dev', 'atlas'] });
  assert.match(roomKey, /^agent:dev:dashboard:/);
  await h.team.send(roomKey, { text: 'what is 2+2?', userLabel: 'Houman' });
  await h.settle();
  assert.deepEqual(h.room(roomKey), ['[Houman]\n\nwhat is 2+2?', '[Dev]\n\ndev answer']);
  const r = h.team.room(roomKey);
  assert.deepEqual(Object.values(r.authors), [{ type: 'user', agentId: null }, { type: 'agent', agentId: 'dev' }]);
  assert.equal(r.agents.every(a => a.workKey), true);
  assert.equal(h.calls.filter(c => c.method === 'chat.send').length, 2);
  assert.equal(h.team.isWorkKey(r.agents[0].workKey), true);
  assert.equal(h.team.isWorkKey(roomKey), false);
});

test('mention gating: only the mentioned agent runs; the other catches up next time', async () => {
  const prompts = {};
  const h = harness((agent, prompt) => { (prompts[agent] ||= []).push(prompt); return `${agent} reply`; });
  const { roomKey } = await h.team.createRoom({ agentIds: ['dev', 'atlas'] });
  await h.team.send(roomKey, { text: '@atlas first question', userLabel: 'H' });
  await h.settle();
  assert.equal(prompts.dev, undefined);
  assert.match(prompts.atlas[0], /addressed to you/);
  await h.team.send(roomKey, { text: '@dev your turn', userLabel: 'H' });
  await h.settle();
  // dev sees the earlier exchange it missed, but not its own messages
  assert.match(prompts.dev[0], /\[H\]: @atlas first question[\s\S]*\[Atlas\]: atlas reply[\s\S]*\[H\]: @dev your turn/);
  assert.equal(prompts.atlas.length, 1);
});

test('@all makes everyone answer; discuss runs follow-up rounds until everyone passes', async () => {
  let round2 = 0;
  const h = harness((agent, prompt) => {
    if (/just replied/.test(prompt)) { round2++; return agent === 'atlas' && round2 <= 2 ? 'atlas adds one thing' : 'NO_REPLY'; }
    return `${agent} first`;
  });
  const { roomKey } = await h.team.createRoom({ agentIds: ['dev', 'atlas'] });
  h.team.setDiscuss(roomKey, true);
  await h.team.send(roomKey, { text: '@all go', userLabel: 'H' });
  await h.settle();
  assert.deepEqual(h.room(roomKey), ['[H]\n\n@all go', '[Dev]\n\ndev first', '[Atlas]\n\natlas first', '[Atlas]\n\natlas adds one thing']);
  // round 2: both (each saw a sibling reply). Round 3: only atlas replied and named nobody,
  // so nobody is eligible (dev neither replied nor was named): 2 + 2 sends.
  assert.equal(h.calls.filter(c => c.method === 'chat.send').length, 4);
});

test('without discuss there is exactly one round', async () => {
  const h = harness(agent => `${agent} says`);
  const { roomKey } = await h.team.createRoom({ agentIds: ['dev', 'atlas'] });
  await h.team.send(roomKey, { text: '@all hi', userLabel: 'H' });
  await h.settle();
  assert.equal(h.calls.filter(c => c.method === 'chat.send').length, 2);
});

test('stop aborts running agents and drops queued messages; later messages still run', async () => {
  const pending = [];
  const h = harness(agent => new Promise(resolve => pending.push({ agent, resolve })));
  const { roomKey } = await h.team.createRoom({ agentIds: ['dev', 'atlas'] });
  await h.team.send(roomKey, { text: '@dev one', userLabel: 'H' });
  await h.team.send(roomKey, { text: '@dev two (queued)', userLabel: 'H' });
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.equal(pending.length, 1);
  await h.team.stop(roomKey);
  assert.equal(h.calls.filter(c => c.method === 'chat.abort').length, 1);
  pending[0].resolve(null); // the gateway reports the aborted run
  await h.team.send(roomKey, { text: '@dev three', userLabel: 'H' });
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.equal(pending.length, 2);
  assert.match(h.calls.filter(c => c.method === 'chat.send').at(-1).params.message, /three/);
  pending[1].resolve('done');
  await h.settle();
  // "two" was already in the room when "one" was dispatched, so dev saw it there; it never got a run of its own
  assert.equal(h.calls.filter(c => c.method === 'chat.send').length, 2);
  assert.equal(h.room(roomKey).at(-1), '[Dev]\n\ndone');
});

test('converting an existing chat keeps it as the agent working session; delete cleans up', async () => {
  const h = harness(agent => `${agent} ok`);
  const source = 'agent:atlas:dashboard:old-chat';
  h.sessions.set(source, []);
  const created = await h.team.createRoom({ sourceKey: source, agentIds: ['dev'], label: 'Old title', category: 'Work' });
  assert.equal(created.agents[0].agentId, 'atlas');
  assert.equal(created.agents[0].workKey, source);
  assert.equal(h.team.isWorkKey(source), true);
  const createCall = h.calls.find(c => c.method === 'sessions.create');
  assert.equal(createCall.params.label, 'Old title');
  assert.equal(createCall.params.category, 'Work');
  await assert.rejects(h.team.createRoom({ sourceKey: source, agentIds: ['main'] }), /already part/);

  const lens = new SessionLens({ broadcast() {}, team: h.team });
  assert.equal(lens.isVisible(source), false);
  assert.equal(lens.forwardsRunEvent(source), true);
  assert.equal(lens.isVisible(created.roomKey), true);

  lens.sessionsChanged({ sessionKey: created.roomKey, reason: 'delete' });
  assert.equal(h.team.room(created.roomKey), null);
  assert.equal(h.team.isWorkKey(source), false);
  assert.ok(h.calls.some(c => c.method === 'sessions.delete' && c.params.key === source));
});

test('room title: gateway titler first, main-model titler when it has no utility model', async () => {
  const a = harness(() => 'NO_REPLY');
  const r1 = (await a.team.createRoom({ agentIds: ['dev', 'atlas'] })).roomKey;
  await a.team.send(r1, { text: 'plan the offsite', userLabel: 'H' });
  await a.settle();
  assert.deepEqual(a.calls.find(c => c.method === 'sessions.patch').params, { key: r1, label: 'Team title' });

  const b = harness(() => 'NO_REPLY', { preparedTitle: null, titler: async m => `T: ${m}` });
  const r2 = (await b.team.createRoom({ agentIds: ['dev', 'atlas'] })).roomKey;
  await b.team.send(r2, { text: 'plan the offsite', userLabel: 'H' });
  await b.settle();
  assert.deepEqual(b.calls.find(c => c.method === 'sessions.patch').params, { key: r2, label: 'T: plan the offsite' });
});

test('a team chat needs two agents; removing down to one is refused', async () => {
  const h = harness(() => 'x');
  await assert.rejects(h.team.createRoom({ agentIds: ['dev'] }), /at least two/);
  const { roomKey } = await h.team.createRoom({ agentIds: ['dev', 'atlas'] });
  assert.throws(() => h.team.removeAgent(roomKey, 'dev'), /at least two/);
  await h.team.addAgent(roomKey, 'main');
  assert.deepEqual(h.team.removeAgent(roomKey, 'dev').agents.map(a => a.agentId), ['atlas', 'main']);
});

test('stop: a partial reply is posted marked stopped; a reply that finished anyway is posted', async () => {
  const pending = [];
  const h = harness(agent => new Promise(resolve => pending.push({ agent, resolve })));
  const { roomKey } = await h.team.createRoom({ agentIds: ['dev', 'atlas'] });
  await h.team.send(roomKey, { text: '@all go', userLabel: 'H' });
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.equal(pending.length, 2);
  await h.team.stop(roomKey);
  pending.find(p => p.agent === 'dev').resolve({ partial: 'half an', state: 'aborted' });
  pending.find(p => p.agent === 'atlas').resolve('atlas finished anyway');
  await h.settle();
  const room = h.room(roomKey);
  assert.ok(room.includes('[Dev]\n\nhalf an more\n\n*[stopped]*'));
  assert.ok(room.includes('[Atlas]\n\natlas finished anyway'));
  assert.equal(h.calls.filter(c => c.method === 'chat.send').length, 2); // no follow-up round after Stop
});

test('a failed turn shows in the room with its partial text', async () => {
  const h = harness(agent => agent === 'dev' ? { partial: 'started', state: 'error', error: 'runtime died' } : 'NO_REPLY');
  const { roomKey } = await h.team.createRoom({ agentIds: ['dev', 'atlas'] });
  await h.team.send(roomKey, { text: 'hello', userLabel: 'H' });
  await h.settle();
  assert.equal(h.room(roomKey).at(-1), "[Dev]\n\nstarted more\n\n⚠️ *Couldn't finish this reply: runtime died*");
});

test('working session labels are unique per room; unknown agents are refused', async () => {
  const h = harness(() => 'ok');
  const a = (await h.team.createRoom({ agentIds: ['dev', 'atlas'] })).roomKey;
  const b = (await h.team.createRoom({ agentIds: ['dev', 'atlas'] })).roomKey;
  await h.team.send(a, { text: '@dev hi', userLabel: 'H' });
  await h.team.send(b, { text: '@dev hi', userLabel: 'H' });
  await h.settle();
  const labels = h.calls.filter(c => c.method === 'sessions.create' && c.params.label).map(c => c.params.label);
  assert.equal(labels.length, 2);
  assert.notEqual(labels[0], labels[1]);
  await assert.rejects(h.team.createRoom({ agentIds: ['dev', 'ghost'] }), /unknown agent: ghost/);
  await assert.rejects(h.team.addAgent(a, 'ghost'), /unknown agent/);
});
