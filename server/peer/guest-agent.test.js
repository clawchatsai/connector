import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuestAgent, GUEST_TOOLS, GUEST_TOOLS_DENY, hasGuestRestrictions } from './guest-agent.js';

function fakeGateway() {
  const agents = [{ id: 'jarvis', identity: { name: 'Jarvis', emoji: '🤖' }, model: { primary: 'anthropic/claude-x' }, workspace: '/home/k/.openclaw/workspace' }];
  const files = { jarvis: { 'SOUL.md': 'be kind', 'IDENTITY.md': 'I am Jarvis', 'MEMORY.md': 'owner secrets', 'USER.md': 'owner profile' } };
  const calls = [];
  const config = {};
  const request = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case 'agents.list': return { agents };
      // Like the real gateway: the new agent only appears after the config reload (a few calls later).
      case 'agents.create': { const id = 'jarvis-guest'; setTimeout(() => agents.push({ id, identity: { name: params.name } }), 30); files[id] = {}; return { ok: true, agentId: id, name: params.name, workspace: '/w/jarvis-guest' }; }
      case 'agents.files.get': { const c = files[params.agentId]?.[params.name]; return { file: { name: params.name, missing: c == null, content: c } }; }
      case 'agents.files.set': if (!agents.some(a => a.id === params.agentId)) throw new Error(`agent "${params.agentId}" not found`); files[params.agentId][params.name] = params.content; return { ok: true };
      case 'config.get': return { hash: 'h1', parsed: { agents: { entries: Object.fromEntries(Object.entries(config).map(([k, v]) => [k, v])) } } };
      case 'config.patch': { const p = JSON.parse(params.raw).agents.entries; for (const [k, v] of Object.entries(p)) config[k] = v; return { ok: true }; }
      default: throw new Error(method);
    }
  };
  return { request, calls, files, agents, config };
}

test('guest agent: same model + personality, no private memory, deny list applied; reused next time', async () => {
  const g = fakeGateway();
  const r = await createGuestAgent(g.request, 'jarvis');
  assert.deepEqual(r, { agentId: 'jarvis-guest', name: 'Jarvis (guest)', created: true });
  const create = g.calls.find(c => c.method === 'agents.create').params;
  assert.deepEqual(create, { name: 'Jarvis (guest)', workspace: '/home/k/.openclaw/workspace-jarvis-guest', model: 'anthropic/claude-x', emoji: '🤖' });
  assert.equal(create.workspace, '/home/k/.openclaw/workspace-jarvis-guest'); // its own folder, next to (not inside) the original's
  assert.deepEqual(g.files['jarvis-guest'], { 'SOUL.md': 'be kind', 'IDENTITY.md': 'I am Jarvis' });
  const patch = g.calls.find(c => c.method === 'config.patch').params;
  assert.deepEqual(JSON.parse(patch.raw), { agents: { entries: { 'jarvis-guest': { tools: GUEST_TOOLS } } } });
  assert.equal(patch.baseHash, 'h1');
  // Allowlist (minimal profile) plus every group that reaches beyond its own folder denied on top.
  assert.equal(GUEST_TOOLS.profile, 'minimal');
  // File tools pinned to the guest's own folder; nothing extra allowed beyond files + exec.
  assert.equal(GUEST_TOOLS.fs.workspaceOnly, true);
  assert.deepEqual(GUEST_TOOLS.alsoAllow, ['group:fs', 'group:runtime']);
  for (const t of ['group:sessions', 'group:messaging', 'group:automation', 'group:ui', 'group:nodes', 'group:plugins', 'group:agents',
    'sessions_search', 'conversations_send', 'secrets', 'computer', 'message', 'cron', 'browser', 'gateway',
    'view_image', 'pdf']) assert.ok(GUEST_TOOLS_DENY.includes(t), t); // view_image/pdf ignore permission mode: denied

  const again = await createGuestAgent(g.request, 'jarvis');
  assert.deepEqual(again, { agentId: 'jarvis-guest', name: 'Jarvis (guest)', created: false });
  assert.equal(g.calls.filter(c => c.method === 'agents.create').length, 1);
  // Asking for the guest of a guest returns it as is.
  assert.equal((await createGuestAgent(g.request, 'jarvis-guest')).created, false);
});

test('restrictions go on before anything else; a guest left without them is repaired on reuse', async () => {
  const g = fakeGateway();
  await createGuestAgent(g.request, 'jarvis');
  const order = g.calls.map(c => c.method).filter(m => ['agents.create', 'config.patch', 'agents.files.set'].includes(m));
  assert.deepEqual(order.slice(0, 2), ['agents.create', 'config.patch']); // deny list before personality
  // Simulate a half-made guest (deny list lost), then reuse: it gets its restrictions back.
  delete g.config['jarvis-guest'];
  await createGuestAgent(g.request, 'jarvis');
  assert.deepEqual(g.config['jarvis-guest'].tools, GUEST_TOOLS);
  // Already restricted: no needless config write.
  const patches = g.calls.filter(c => c.method === 'config.patch').length;
  await createGuestAgent(g.request, 'jarvis');
  assert.equal(g.calls.filter(c => c.method === 'config.patch').length, patches);
});

test('hasGuestRestrictions: only a policy at least as narrow as the guest one passes', () => {
  assert.equal(hasGuestRestrictions(GUEST_TOOLS), true);
  assert.equal(hasGuestRestrictions({ deny: GUEST_TOOLS_DENY }), false);                                   // old deny-only policy
  assert.equal(hasGuestRestrictions({ ...GUEST_TOOLS, profile: 'full' }), false);
  assert.equal(hasGuestRestrictions({ ...GUEST_TOOLS, alsoAllow: [...GUEST_TOOLS.alsoAllow, 'message'] }), false);
  assert.equal(hasGuestRestrictions({ ...GUEST_TOOLS, deny: GUEST_TOOLS_DENY.slice(1) }), false);
  assert.equal(hasGuestRestrictions({ ...GUEST_TOOLS, allow: ['*'] }), false);
  assert.equal(hasGuestRestrictions(undefined), false);
  // File tools must be workspace-pinned.
  assert.equal(hasGuestRestrictions({ ...GUEST_TOOLS, fs: undefined }), false);
  assert.equal(hasGuestRestrictions({ ...GUEST_TOOLS, fs: { workspaceOnly: false } }), false);
  // A guest made before view_image/pdf were removed (still in alsoAllow) no longer passes.
  assert.equal(hasGuestRestrictions({ ...GUEST_TOOLS, alsoAllow: ['group:fs', 'group:runtime', 'view_image', 'pdf'] }), false);
});

test('findGuestAgent: the guest made as "main (guest)" is still found after the original is renamed', async () => {
  const { findGuestAgent } = await import('./guest-agent.js');
  const agents = [
    { id: 'main', identity: { name: 'homiabot' } },
    { id: 'main-guest', identity: { name: 'main (guest)' } },
    { id: 'dev', name: 'dev' },
    { id: 'dev-guest', name: 'dev (guest)' },
  ];
  assert.equal(findGuestAgent(agents, 'main')?.id, 'main-guest');
  assert.equal(findGuestAgent(agents, 'dev')?.id, 'dev-guest');
  // An agent that merely has the id shape isn't taken for a guest.
  assert.equal(findGuestAgent([{ id: 'x', name: 'x' }, { id: 'x-guest', name: 'something else' }], 'x'), null);
});
