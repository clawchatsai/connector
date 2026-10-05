import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuestAgent, GUEST_TOOLS_DENY } from './guest-agent.js';

function fakeGateway() {
  const agents = [{ id: 'jarvis', identity: { name: 'Jarvis', emoji: '🤖' }, model: { primary: 'anthropic/claude-x' } }];
  const files = { jarvis: { 'SOUL.md': 'be kind', 'IDENTITY.md': 'I am Jarvis', 'MEMORY.md': 'owner secrets', 'USER.md': 'owner profile' } };
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case 'agents.list': return { agents };
      case 'agents.create': { const id = 'jarvis-guest'; agents.push({ id, identity: { name: params.name } }); files[id] = {}; return { ok: true, agentId: id, name: params.name, workspace: '/w/jarvis-guest' }; }
      case 'agents.files.get': { const c = files[params.agentId]?.[params.name]; return { file: { name: params.name, missing: c == null, content: c } }; }
      case 'agents.files.set': files[params.agentId][params.name] = params.content; return { ok: true };
      case 'config.get': return { hash: 'h1' };
      case 'config.patch': return { ok: true };
      default: throw new Error(method);
    }
  };
  return { request, calls, files, agents };
}

test('guest agent: same model + personality, no private memory, deny list applied; reused next time', async () => {
  const g = fakeGateway();
  const r = await createGuestAgent(g.request, 'jarvis');
  assert.deepEqual(r, { agentId: 'jarvis-guest', name: 'Jarvis (guest)', created: true });
  const create = g.calls.find(c => c.method === 'agents.create').params;
  assert.deepEqual(create, { name: 'Jarvis (guest)', model: 'anthropic/claude-x', emoji: '🤖' });
  assert.equal('workspace' in create, false); // its own fresh workspace
  assert.deepEqual(g.files['jarvis-guest'], { 'SOUL.md': 'be kind', 'IDENTITY.md': 'I am Jarvis' });
  const patch = g.calls.find(c => c.method === 'config.patch').params;
  assert.deepEqual(JSON.parse(patch.raw), { agents: { entries: { 'jarvis-guest': { tools: { deny: GUEST_TOOLS_DENY } } } } });
  assert.equal(patch.baseHash, 'h1');
  for (const t of ['message', 'cron', 'browser', 'nodes', 'sessions_send', 'sessions_history', 'gateway']) assert.ok(GUEST_TOOLS_DENY.includes(t), t);

  const again = await createGuestAgent(g.request, 'jarvis');
  assert.deepEqual(again, { agentId: 'jarvis-guest', name: 'Jarvis (guest)', created: false });
  assert.equal(g.calls.filter(c => c.method === 'agents.create').length, 1);
  // Asking for the guest of a guest returns it as is.
  assert.equal((await createGuestAgent(g.request, 'jarvis-guest')).created, false);
});
