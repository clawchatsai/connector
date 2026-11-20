import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../bootstrap/native.js';
import { SharingManager, defangLocalPaths } from './sharing.js';
import { loadOrCreatePeerKey, fingerprint } from './keys.js';
import { GUEST_TOOLS, unappliedGuests } from './guest-agent.js';

const quiet = { warn() {}, info() {} };
const keyIn = () => loadOrCreatePeerKey(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-')));
const wait = ms => new Promise(r => setTimeout(r, ms));

function pair() {
  const mk = () => ({ handlers: [], closed: [], other: null, open: true,
    send(s) { if (this.open && this.other.open) setImmediate(() => this.other.handlers.forEach(h => h(s))); },
    close() { if (!this.open) return; this.open = false; setImmediate(() => this.closed.forEach(h => h())); this.other.close(); }, // async, like a real DataChannel
    onMessage(h) { this.handlers.push(h); }, onClosed(h) { this.closed.push(h); } });
  const a = mk(), b = mk(); a.other = b; b.other = a;
  return [a, b];
}

/** Owner (Kamil, gateway gwK) shares with requester (Houman, gateway gwH). */
function setup({ reply = p => `jarvis says: ${p.message.split('\n\n').pop()}`, config = {}, cfgExtra = {} } = {}) {
  const kOwner = keyIn(), kReq = keyIn();
  const ownerCalls = [], ownerSignals = [], reqSignals = [];
  let owner;
  const ownerRequest = async (method, params) => {
    ownerCalls.push({ method, params });
    if (method === 'chat.send') {
      setImmediate(() => {
        owner.onGatewayEvent({ event: 'chat', payload: { runId: params.idempotencyKey, state: 'delta', message: { content: [{ type: 'text', text: 'jar' }] } } });
        const text = reply(params);
        if (text === null) return; // stays running (abort test)
        owner.onGatewayEvent({ event: 'chat', payload: { runId: params.idempotencyKey, state: 'final', message: { content: [{ type: 'text', text }] } } });
      });
      return { runId: params.idempotencyKey, status: 'started' };
    }
    if (method === 'config.get') return { hash: 'h', parsed: config, ...cfgExtra };
    if (method === 'chat.abort') { setImmediate(() => owner.onGatewayEvent({ event: 'chat', payload: { runId: params.runId, state: 'aborted' } })); return { ok: true }; }
    return { ok: true };
  };
  const ownerDb = new Database(':memory:'), reqDb = new Database(':memory:');
  owner = new SharingManager({ getDb: () => ownerDb, request: ownerRequest, recovery: { waitMs: 60, pollMs: 5 }, key: kOwner, gatewayId: () => 'gwK', signal: m => ownerSignals.push(m), openPeer: async () => { throw new Error('owner never dials'); }, log: quiet });
  const req = new SharingManager({
    getDb: () => reqDb, request: async () => ({}), key: kReq, gatewayId: () => 'gwH', signal: m => reqSignals.push(m), log: quiet, resendBackoffMs: [5, 10],
    openPeer: async shareId => {
      const [a, b] = pair();
      owner.servePeer({ dc: b, dtls: { local: 'FK', remote: 'FH' }, shareId, requesterGatewayId: 'gwH' });
      return { dc: a, dtls: { local: 'FH', remote: 'FK' } };
    },
  });
  const people = { requester: { name: 'Houman S', email: 'h@x.dev', gatewayId: 'gwH', pubKey: kReq.publicKey }, owner: { name: 'Kamil', email: 'k@x.dev', gatewayId: 'gwK', pubKey: kOwner.publicKey } };
  const pending = { id: 'sh1', status: 'pending', ...people, agents: [] };
  owner.setShares([{ ...pending, as: 'owner' }]);
  req.setShares([{ ...pending, as: 'requester' }]);
  /** The signal server activating the share from the owner's signed grant. */
  const activate = () => {
    const g = ownerSignals.filter(m => m.type === 'share-grant').at(-1);
    const active = { ...people, id: 'sh1', status: 'active', agents: g.grant.agents, grant: g.grant, signature: g.signature };
    owner.setShares([{ ...active, as: 'owner' }]);
    req.setShares([{ ...active, as: 'requester' }]);
    return active;
  };
  return { owner, req, ownerCalls, ownerSignals, reqSignals, activate, kOwner, kReq, people };
}

test('a guest session the owner deleted is made again on the next turn, with its label in "Shared with <name>"', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }], access: 'restricted', dailyCap: 10 });
  s.activate();
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't1', roomId: 'room1', roomTitle: 'Rivers', message: 'hi' });
  const first = s.ownerCalls.find(c => c.method === 'sessions.create').params;

  // Deleted from the owner's chat list: the gateway no longer has it.
  const request = s.owner.request;
  s.owner.request = async (method, params) => (method === 'sessions.describe' && params.key === first.key ? { session: null } : request(method, params));
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't2', roomId: 'room1', roomTitle: 'Rivers', message: 'still there?' });
  const creates = s.ownerCalls.filter(c => c.method === 'sessions.create').map(c => c.params);
  assert.equal(creates.length, 2);
  assert.deepEqual([creates[1].key, creates[1].label, creates[1].category, creates[1].permissionMode], [first.key, first.label, 'Shared with Houman S', 'read-only']);
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').at(-1).params.sessionKey, first.key);

  // Still there: reused, no new session.
  s.owner.request = request;
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't3', roomId: 'room1', message: 'and again' });
  assert.equal(s.ownerCalls.filter(c => c.method === 'sessions.create').length, 2);
});

test('a shared agent renamed by its owner: the grant is re-issued with the new name, same access and cap', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }], access: 'trusted', dailyCap: 7 });
  s.activate();
  let agents = [{ id: 'jarvis', identity: { name: 'Jarvis' } }, { id: 'jarvis-guest', identity: { name: 'Jarvis (guest)' } }];
  const request = s.owner.request;
  s.owner.request = async (method, params) => (method === 'agents.list' ? { agents } : request(method, params));
  assert.deepEqual(await s.owner.syncAgentNames(), [], 'nothing renamed: no new grant');

  agents = [{ id: 'jarvis', identity: { name: 'Jarvy' } }, { id: 'jarvis-guest', identity: { name: 'Jarvis (guest)' } }];
  assert.deepEqual(await s.owner.syncAgentNames(), ['sh1']);
  const g = s.ownerSignals.filter(m => m.type === 'share-grant').at(-1).grant;
  assert.deepEqual([g.agents, g.access, g.dailyCap], [[{ id: 'jarvis-guest', name: 'Jarvy' }], 'trusted', 7]);
  s.activate();
  assert.equal(s.req.remoteAgents()[0].name, 'Jarvy · Kamil', 'the requester sees the new name');
  assert.deepEqual(await s.owner.syncAgentNames(), [], 'once');
});

test("funnel: a person's chats go to the project chosen for them; renames follow, moving existing chats, default until chosen", async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }], access: 'restricted', dailyCap: 10 });
  s.activate();
  assert.equal(s.owner.funnelOf('h@x.dev', 'Houman S'), 'Shared with Houman S', 'nothing chosen: named after them');

  // Chosen at invite/accept time (before any chat): the first guest session is made there.
  await s.owner.setFunnel('H@x.dev', 'Friends');
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't1', roomId: 'room1', roomTitle: 'Rivers', message: 'hi' });
  const create = s.ownerCalls.find(c => c.method === 'sessions.create').params;
  assert.equal(create.category, 'Friends');

  // Changed later: chats already there move, including ones from a share since ended (a new share replaced it).
  const db = s.owner._db();
  db.prepare('INSERT INTO peer_grants (share_id, grant_json, sig, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)').run('old1', JSON.stringify({ requesterGatewayId: 'gwH', agents: [] }), 'x', 1, 2);
  db.prepare('INSERT INTO peer_sessions (share_id, room_id, agent_id, session_key) VALUES (?, ?, ?, ?)').run('old1', 'r0', 'jarvis-guest', 'agent:jarvis-guest:dashboard:old');
  const moved = await s.owner.setFunnel('h@x.dev', 'Work friends');
  assert.equal(moved.moved, 2);
  assert.deepEqual(s.ownerCalls.filter(c => c.method === 'sessions.patch' && c.params.category).map(c => [c.params.key, c.params.category]).sort(),
    [[create.key, 'Work friends'], ['agent:jarvis-guest:dashboard:old', 'Work friends']].sort());

  // The project is renamed in ClawChats: they follow. Deleted: the next chat makes it again (sessions.create names it).
  assert.equal(s.owner.renameFunnel('Work friends', 'Team'), 1);
  assert.equal(s.owner.funnelOf('h@x.dev', 'Houman S'), 'Team');
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't2', roomId: 'room2', roomTitle: 'Lakes', message: 'again' });
  assert.equal(s.ownerCalls.filter(c => c.method === 'sessions.create').at(-1).params.category, 'Team');
  assert.deepEqual(s.owner.funnels(), { 'h@x.dev': 'Team' });
});

test('a gateway with no id can\'t sign a grant (the server would refuse it silently); a refused grant is dropped and the owner told', async () => {
  const s = setup();
  const frames = [];
  const gid = s.owner.gatewayId;
  s.owner.broadcast = f => frames.push(JSON.parse(f));
  s.owner.gatewayId = () => ''; // a legacy install: logged in by user id, no id saved
  assert.throws(() => s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }] }), /isn't connected to the signal server yet/);
  assert.equal(s.ownerSignals.filter(m => m.type === 'share-grant').length, 0, 'nothing was sent');

  s.owner.gatewayId = gid;
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }] });
  assert.equal(s.ownerSignals.filter(m => m.type === 'share-grant').at(-1).grant.ownerGatewayId, 'gwK');
  // The server says no while the share is still pending: the local grant goes, and the browser is told.
  s.owner.onGrantRejected('sh1');
  assert.equal(s.owner._db().prepare('SELECT COUNT(*) n FROM peer_grants WHERE share_id = ?').get('sh1').n, 0);
  assert.ok(frames.some(f => f.event === 'sharing-error' && f.shareId === 'sh1' && /Try again/.test(f.message)));

  // An edit of a share that was already active: refused, but the share keeps working as it did.
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }] });
  s.activate();
  s.owner.onGrantRejected('sh1');
  assert.equal(s.owner._db().prepare('SELECT COUNT(*) n FROM peer_grants WHERE share_id = ?').get('sh1').n, 1);
  assert.ok(frames.at(-2).message.includes('as it was'));
});

test("the sessions answering a host's room are listed per host and room, so their approvals can show in the room", async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }], access: 'trusted', dailyCap: 10 });
  s.activate();
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't1', roomId: 'room1', roomTitle: 'Rivers', message: 'hi' });
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't2', roomId: 'room2', roomTitle: 'Lakes', message: 'hi' });
  const key = s.ownerCalls.find(c => c.method === 'sessions.create').params.key;
  assert.deepEqual(s.owner.guestSessionKeysFor('gwH', 'room1'), [key]);
  assert.deepEqual(s.owner.guestSessionKeysFor('gwH', 'room3'), []);
  assert.deepEqual(s.owner.guestSessionKeysFor('gwOther', 'room1'), [], 'another host with the same room id is not this room');
});

test('a guest session being made tells the app, so the room knows it before the agent asks for anything', async () => {
  const s = setup();
  const frames = [];
  s.owner.broadcast = f => frames.push(JSON.parse(f).event);
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }], access: 'trusted', dailyCap: 10 });
  s.activate();
  frames.length = 0;
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't1', roomId: 'room1', roomTitle: 'Rivers', message: 'hi' });
  const created = s.ownerCalls.findIndex(c => c.method === 'sessions.create');
  assert.ok(created >= 0);
  assert.ok(frames.filter(e => e === 'sharing-changed').length >= 2, 'once for the usage count, once when the session exists');
  assert.ok(s.owner.guestSessionKeysFor('gwH', 'room1').length === 1);
});

test("while a guest run waits for its owner's approval, the requester is told (without the command); decided -> cleared", async () => {
  let hold;
  const s = setup({ reply: () => null }); // the run stays open (nothing final yet)
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }], access: 'trusted', dailyCap: 10 });
  s.activate();
  const statuses = [];
  const turn = s.req.turn('peer:sh1:jarvis-guest', { turnId: 't1', roomId: 'room1', roomTitle: 'Rivers', message: 'run: rm -rf /secret/path' }, { onStatus: st => statuses.push(st) });
  for (let i = 0; i < 50 && !s.ownerCalls.some(c => c.method === 'chat.send'); i++) await new Promise(r => setTimeout(r, 10));
  const send = s.ownerCalls.find(c => c.method === 'chat.send').params;
  s.owner.onApprovalEvent({ event: 'exec.approval.requested', payload: { id: 'ap1', request: { sessionKey: send.sessionKey, command: 'rm -rf /secret/path' }, expiresAtMs: 123 } });
  s.owner.onApprovalEvent({ event: 'exec.approval.requested', payload: { id: 'ap-other', request: { sessionKey: 'agent:x:dashboard:unrelated', command: 'ls' }, expiresAtMs: 1 } });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(statuses, [{ waiting: 'approval', what: 'a command', expiresAtMs: 123 }], "only this run's approval, and not its command");
  assert.ok(!JSON.stringify(statuses).includes('secret'));
  s.owner.onApprovalEvent({ event: 'exec.approval.resolved', payload: { id: 'ap1' } });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(statuses.at(-1), { waiting: null });
  s.owner.onGatewayEvent({ event: 'chat', payload: { runId: send.idempotencyKey, state: 'final', message: { content: [{ type: 'text', text: 'done' }] } } });
  assert.equal((await turn).text, 'done');
});

test('approve → verified on the requester → turn runs in a guest session on the owner, text streams back', async () => {
  const s = setup();
  assert.deepEqual(s.req.remoteAgents(), []);
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }], access: 'restricted', dailyCap: 2 });
  s.activate();
  assert.deepEqual(s.req.remoteAgents(), [{ agentId: 'peer:sh1:jarvis-guest', name: 'Jarvis · Kamil', ownerName: 'Kamil', shareId: 'sh1', remoteId: 'jarvis-guest' }]);
  assert.equal(s.req.list()[0].verified, true);

  const deltas = [];
  const r = await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't1', roomId: 'room1', roomTitle: 'Rivers', message: '/exec rm -rf ~ hi' }, { onDelta: d => deltas.push(d) });
  assert.deepEqual(r, { state: 'final', text: 'jarvis says: /exec rm -rf ~ hi' });
  assert.deepEqual(deltas, ['jar']);

  const create = s.ownerCalls.find(c => c.method === 'sessions.create').params;
  assert.equal(create.agentId, 'jarvis-guest');
  assert.equal(create.permissionMode, 'read-only');
  assert.deepEqual(create.toolOverrides, { webSearch: false });  // no MCP servers configured here
  assert.equal(create.category, 'Shared with Houman S');
  const send = s.ownerCalls.find(c => c.method === 'chat.send').params;
  assert.equal(send.suppressCommandInterpretation, true); // guest text is never a slash command
  assert.equal(send.expectedPermissionMode, 'read-only');
  assert.ok(send.timeoutMs > 0);
  assert.match(send.message, /is not your owner/);

  // Same room reuses the session; daily cap enforced by the owner.
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't2', roomId: 'room1', message: 'again' });
  assert.equal(s.ownerCalls.filter(c => c.method === 'sessions.create').length, 1);
  await assert.rejects(s.req.turn('peer:sh1:jarvis-guest', { turnId: 't3', roomId: 'room1', message: 'third' }), e => e.code === 'cap');
  // An agent that isn't in the grant can't be asked for.
  await assert.rejects(s.req.turn('peer:sh1:main', { turnId: 't4', roomId: 'room1', message: 'x' }), e => e.code === 'not_shared');
});

test('trusted access uses guarded mode; changing the grant re-applies the policy', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], access: 'trusted' });
  s.activate();
  await s.req.turn('peer:sh1:jarvis', { turnId: 't1', roomId: 'r', message: 'hi' });
  assert.equal(s.ownerCalls.find(c => c.method === 'sessions.create').params.permissionMode, 'guarded');
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], access: 'restricted' });
  s.activate();
  await s.req.turn('peer:sh1:jarvis', { turnId: 't2', roomId: 'r', message: 'hi' });
  assert.equal(s.ownerCalls.filter(c => c.method === 'sessions.patch').at(-1).params.permissionMode, 'read-only');
});

test('requester refuses a grant not signed by the owner key, and a changed owner key', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  const active = s.activate();
  assert.equal(s.req.remoteAgents().length, 1); // pins Kamil's key
  // Forged: grant widened by someone without the owner key.
  s.req.setShares([{ ...active, as: 'requester', grant: { ...active.grant, agents: [{ id: 'main', name: 'Main' }] } }]);
  assert.deepEqual(s.req.remoteAgents(), []);
  // Owner key swapped (e.g. a compromised relay) even with a valid signature by the new key.
  const evil = keyIn();
  const grant = { ...active.grant };
  s.req.setShares([{ ...active, as: 'requester', owner: { ...active.owner, pubKey: evil.publicKey }, grant, signature: evil.signJson(grant) }]);
  assert.deepEqual(s.req.remoteAgents(), []);
});

test('owner never serves without a local grant, nor to another requester gateway; revoke stops turns', async () => {
  const s = setup();
  const [a, b] = pair();
  assert.equal(s.owner.servePeer({ dc: b, dtls: {}, shareId: 'sh1', requesterGatewayId: 'gwH' }), null); // no grant yet
  assert.equal(a.open, false);
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  const [c, d] = pair();
  assert.equal(s.owner.servePeer({ dc: d, dtls: {}, shareId: 'sh1', requesterGatewayId: 'gwEVE' }), null);
  assert.equal(c.open, false);

  await s.req.turn('peer:sh1:jarvis', { turnId: 't1', roomId: 'r', message: 'hi' });
  s.owner.revoke('sh1');
  assert.deepEqual(s.ownerSignals.at(-1), { type: 'share-revoke', shareId: 'sh1' });
  await wait(10);
  await assert.rejects(s.req.turn('peer:sh1:jarvis', { turnId: 't2', roomId: 'r', message: 'hi' }));
});

test('abort reaches the owner run; the turn ends aborted', async () => {
  const s = setup({ reply: () => null });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  const run = s.req.turn('peer:sh1:jarvis', { turnId: 't9', roomId: 'r', message: 'long' });
  await wait(20);
  await s.req.abort('peer:sh1:jarvis', 't9');
  assert.deepEqual(await run, { state: 'aborted', text: 'jar' });
  assert.ok(s.ownerCalls.some(c => c.method === 'chat.abort'));
});

test('guest sessions of different rooms never collide on their label (untitled rooms), and a clash retries', async () => {
  const labels = new Set();
  const s = setup();
  const orig = s.owner.request;
  s.owner.request = async (method, params) => {
    if (method === 'sessions.create') {
      if (labels.has(params.label)) throw new Error(`label already in use: ${params.label}`);
      labels.add(params.label);
    }
    return orig(method, params);
  };
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 10 });
  s.activate();
  await s.req.turn('peer:sh1:jarvis', { turnId: 'a', roomId: 'roomA', message: 'hi' }); // both untitled → "team chat"
  await s.req.turn('peer:sh1:jarvis', { turnId: 'b', roomId: 'roomB', message: 'hi' });
  assert.equal(labels.size, 2);
  // Even a clash with an unrelated session falls back to a fresh suffix.
  labels.add([...labels][0].replace(/· [0-9a-f]{6}$/, '· ') + 'x'); // unrelated
  const pre = [...labels];
  await s.req.turn('peer:sh1:jarvis', { turnId: 'c', roomId: 'roomC', message: 'hi' });
  assert.equal(labels.size, pre.length + 1);
});

test('guest sessions turn every configured MCP server off, and chat.send checks it', async () => {
  const s = setup({ config: { mcp: { servers: { gmail: {}, 'chrome-devtools': {} } } } });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  await s.req.turn('peer:sh1:jarvis', { turnId: 't1', roomId: 'r', message: 'hi' });
  const want = { webSearch: false, mcpServers: { 'chrome-devtools': false, gmail: false } };
  assert.deepEqual(s.ownerCalls.find(c => c.method === 'sessions.create').params.toolOverrides, want);
  assert.deepEqual(s.ownerCalls.find(c => c.method === 'chat.send').params.expectedToolOverrides, want);
});

test('a guest agent whose restrictions were removed is not served', async () => {
  const config = { agents: { entries: { 'jarvis-guest': { tools: GUEST_TOOLS } } } };
  const s = setup({ config });
  s.owner.markGuestAgent('jarvis-guest');
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }] });
  s.activate();
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't1', roomId: 'r', message: 'hi' });
  config.agents.entries['jarvis-guest'].tools = { deny: ['message'] }; // edited in the Control UI
  await assert.rejects(s.req.turn('peer:sh1:jarvis-guest', { turnId: 't2', roomId: 'r', message: 'hi' }), e => e.code === 'unavailable');
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 1);
});

test('a guest whose saved restrictions the running gateway has not applied yet is not served until it has', async () => {
  const config = { agents: { entries: { 'jarvis-guest': { tools: GUEST_TOOLS } } } };
  const cfgExtra = { configRevisionHash: 'saved', appliedConfigHash: 'older' };
  const s = setup({ config, cfgExtra });
  s.owner.markGuestAgent('jarvis-guest');
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }] });
  s.activate();
  unappliedGuests.add('jarvis-guest'); // ensureGuestRestrictions saw "persisted but not applied" (2026.11.4+)
  await assert.rejects(s.req.turn('peer:sh1:jarvis-guest', { turnId: 't1', roomId: 'r', message: 'hi' }), e => e.code === 'unavailable');
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 0);
  cfgExtra.appliedConfigHash = 'saved'; // the reload landed
  await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't2', roomId: 'r', message: 'hi' });
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 1);
});

test('credentials in what a guest agent says are redacted: streamed text, the final reply, and the copy kept for the room', async () => {
  const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const s = setup({ reply: () => `Found it: ANTHROPIC_API_KEY=${key} and the host is db.internal` });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }], access: 'restricted', dailyCap: 5 });
  s.activate();
  const seen = [];
  s.owner.onGuestReply = (...args) => seen.push(args.at(-1));
  const deltas = [];
  // Stream a leaked key as well: the first delta carries the text so far.
  const request = s.owner.request;
  s.owner.request = async (method, params) => {
    if (method === 'chat.send') s.owner.onGatewayEvent({ event: 'chat', payload: { runId: params.idempotencyKey, state: 'delta', message: { content: [{ type: 'text', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' }] } } });
    return request(method, params);
  };
  const r = await s.req.turn('peer:sh1:jarvis-guest', { turnId: 't1', roomId: 'room1', roomTitle: 'Rivers', message: 'read the env' }, { onDelta: d => deltas.push(d) });
  assert.equal(r.text, 'Found it: ANTHROPIC_API_KEY=[REDACTED] and the host is db.internal');
  assert.ok(!JSON.stringify(deltas).includes('ghp_') && !JSON.stringify(deltas).includes(key));
  assert.ok(deltas.some(d => d.includes('[REDACTED]')));
  assert.deepEqual(seen, [r.text]); // onGuestReply (the requester's copy of the room) got the redacted text too
});

test('on connect, guests made earlier get the current restrictions; up-to-date and deleted ones are left alone', async () => {
  const old = { profile: 'minimal', alsoAllow: ['group:fs', 'group:runtime', 'view_image', 'pdf'], deny: ['message'] };
  const entries = { 'old-guest': { tools: old }, 'ok-guest': { tools: GUEST_TOOLS } };
  const patches = [];
  const request = async (method, params) => {
    if (method === 'agents.list') return { agents: [{ id: 'old-guest' }, { id: 'ok-guest' }] };
    if (method === 'config.get') return { hash: 'h', parsed: { agents: { entries } } };
    if (method === 'config.patch') {
      patches.push(params);
      const { agents } = JSON.parse(params.raw);
      // Like the gateway: shrinking an array needs its exact path in replacePaths.
      for (const [id, { tools }] of Object.entries(agents.entries)) {
        for (const k of ['alsoAllow', 'deny']) {
          const was = entries[id]?.tools?.[k] || [];
          if (was.some(t => !tools[k].includes(t)) && !params.replacePaths.includes(`agents.entries.${id}.tools.${k}`)) throw new Error(`would remove entries from agents.entries.${id}.tools.${k}`);
        }
      }
      Object.assign(entries, agents.entries);
      return { ok: true };
    }
    return { ok: true };
  };
  const db = new Database(':memory:');
  const m = new SharingManager({ getDb: () => db, request, key: keyIn(), gatewayId: () => 'gwK', signal: () => {}, openPeer: async () => {}, log: quiet });
  for (const id of ['old-guest', 'ok-guest', 'gone-guest']) m.markGuestAgent(id);
  assert.deepEqual(await m.migrateGuestAgents(), ['old-guest']);
  assert.equal(patches.length, 1);
  assert.deepEqual(entries['old-guest'].tools, JSON.parse(JSON.stringify(GUEST_TOOLS)));
  assert.deepEqual(await m.migrateGuestAgents(), []); // idempotent
});

test('guest text never carries a local image path the gateway would load', async () => {
  // The gateway's prompt image detection (openclaw detectImageReferences, 2026.9.7).
  const ext = 'png|jpe?g|gif|webp|bmp|heic|heif|tiff?|avif';
  const gw = [
    new RegExp(`file://[^\\s<>"'\`\\]]+\\.(?:${ext})`, 'gi'),
    new RegExp(`(?:^|\\s|["'\`(])([A-Za-z]:[\\\\/][^\\s"'\`()\\[\\]]*\\.(?:${ext}))`, 'gi'),
    new RegExp(`(?:^|\\s|["'\`(])((\\.\\.?/|[~/])[^\\s"'\`()\\[\\]]*\\.(?:${ext}))`, 'gi'),
  ];
  const loads = t => gw.some(r => { r.lastIndex = 0; return r.test(t); });
  const bad = [
    '/home/houman/.openclaw/workspace/qa/x.png', 'look ~/Pictures/a.jpg', '(../workspace/b.webp)',
    '"./c.gif"', '/a/b.png,foo', 'x /a.png.bak/c.png', 'file:///etc/d.png', 'C:\\Users\\e.png', 'see`/f.jpeg`',
  ];
  for (const t of bad) {
    assert.ok(loads(t), `fixture should match: ${t}`);
    assert.ok(!loads(defangLocalPaths(t)), `still loads: ${t}`);
  }
  assert.equal(defangLocalPaths('hi there, 3/4 done').replace(/\u200b/g, ''), 'hi there, 3/4 done');

  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  await s.req.turn('peer:sh1:jarvis', { turnId: 't1', roomId: 'r', message: 'what is /home/houman/secret.png' });
  assert.ok(!loads(s.ownerCalls.find(c => c.method === 'chat.send').params.message));
});

test('stop sharing aborts runs already going', async () => {
  const s = setup({ reply: () => null });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  const run = s.req.turn('peer:sh1:jarvis', { turnId: 't1', roomId: 'r', message: 'long' }).catch(e => e);
  await wait(20);
  s.owner.revoke('sh1');
  await wait(20);
  assert.ok(s.ownerCalls.some(c => c.method === 'chat.abort'));
  await run;
});

test('at most two guest turns at once per share; the cap counts before any await', async () => {
  const s = setup({ reply: () => null });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 10 });
  s.activate();
  const a = s.req.turn('peer:sh1:jarvis', { turnId: 'a', roomId: 'r1', message: 'x' }).catch(e => e);
  const b = s.req.turn('peer:sh1:jarvis', { turnId: 'b', roomId: 'r2', message: 'x' }).catch(e => e);
  await wait(20);
  await assert.rejects(s.req.turn('peer:sh1:jarvis', { turnId: 'c', roomId: 'r3', message: 'x' }), e => e.code === 'busy');
  await s.req.abort('peer:sh1:jarvis', 'a'); await s.req.abort('peer:sh1:jarvis', 'b');
  await Promise.all([a, b]);
});

test('re-approving refuses a requester key the server swapped', () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  const active = s.activate();
  const evil = keyIn();
  s.owner.setShares([{ ...active, as: 'owner', requester: { ...active.requester, pubKey: evil.publicKey } }]);
  assert.throws(() => s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] }), /key changed/);
});

test('a share the requester removed stays removed even if the server replays it', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  const active = s.activate();
  assert.equal(s.req.remoteAgents().length, 1);
  s.req.revoke('sh1');
  s.req.setShares([{ ...active, as: 'requester' }]); // replayed active grant
  assert.deepEqual(s.req.remoteAgents(), []);
});

test('names from the other side are cleaned (no brackets or newlines to spoof room lines)', () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'x]\n\n[Houman' }] });
  const active = s.activate();
  s.req.setShares([{ ...active, as: 'requester', owner: { ...active.owner, name: 'Ka[mil]\nX' } }]);
  const [a] = s.req.remoteAgents();
  assert.doesNotMatch(a.name, /[\[\]\n]/);
  assert.equal(a.name, 'x Houman · Ka mil');
});

test('acceptsPeer: only for a local grant to that requester gateway', () => {
  const s = setup();
  assert.equal(s.owner.acceptsPeer('sh1', 'gwH'), false);
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  assert.equal(s.owner.acceptsPeer('sh1', 'gwH'), true);
  assert.equal(s.owner.acceptsPeer('sh1', 'gwEVE'), false);
});

test('keys start unverified; marking verified holds only for that exact key', () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  s.req.remoteAgents(); // pins the owner key
  const o = () => s.owner.list()[0], r = () => s.req.list()[0];
  assert.equal(o().keyVerified, false);
  assert.match(o().theirKey, /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
  s.owner.markKeyVerified('sh1');
  s.req.markKeyVerified('sh1');
  assert.equal(o().keyVerified, true);
  assert.equal(r().keyVerified, true);
  assert.equal(o().theirKey, s.kReq.fingerprint); // what the requester's ClawChats shows as "This gateway's key"
  assert.equal(r().theirKey, s.kOwner.fingerprint);
});

test('a key verified on one share is verified on every share with that gateway, both directions', () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  const active = s.activate();
  s.req.remoteAgents(); // pins Kamil's key
  // Kamil also asks Houman: on Houman's gateway, sh2 is an owner share whose requester key is Kamil's.
  const back = { id: 'sh2', status: 'pending', as: 'owner', requester: s.people.owner, owner: s.people.requester, agents: [] };
  s.req.setShares([{ ...active, as: 'requester' }, back]);
  const byId = id => s.req.list().find(x => x.id === id);
  assert.equal(byId('sh2').theirKey, byId('sh1').theirKey);
  assert.equal(byId('sh2').keyVerified, false);
  s.req.markKeyVerified('sh1');
  assert.equal(byId('sh1').keyVerified, true);
  assert.equal(byId('sh2').keyVerified, true);
  // Someone else's key stays unverified.
  s.req.setShares([{ ...active, as: 'requester' }, { ...back, id: 'sh3', requester: { ...s.people.owner, pubKey: keyIn().publicKey } }]);
  assert.equal(byId('sh3').keyVerified, false);
});

test('a pending request can be verified, and stays verified once approved', () => {
  const s = setup();
  const o = () => s.owner.list()[0];
  assert.equal(o().theirKey, s.kReq.fingerprint);
  s.owner.markKeyVerified('sh1');
  assert.equal(o().keyVerified, true);
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  assert.equal(o().keyVerified, true);
});

test('a reply that fails without text is not counted against the daily cap; one with partial text is', async () => {
  const s = setup({ reply: () => null }); // runs stay open; the test ends them
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 5 });
  s.activate();
  // A guest version whose restrictions were removed: refused before it runs, nothing said.
  s.owner.markGuestAgent('jarvis');
  await assert.rejects(s.req.turn('peer:sh1:jarvis', { turnId: 'f1', roomId: 'room1', message: 'hi' }), e => e.code === 'unavailable');
  assert.equal(s.owner.list()[0].usedToday, 0);
  s.owner._db().prepare('DELETE FROM peer_guest_agents').run();
  // Fails after streaming some text ("jar"): counted.
  const p = s.req.turn('peer:sh1:jarvis', { turnId: 'f2', roomId: 'room1', message: 'hi' });
  for (let i = 0; i < 50 && !s.ownerCalls.some(c => c.method === 'chat.send'); i++) await wait(2);
  await wait(5);
  const runId = s.ownerCalls.filter(c => c.method === 'chat.send').at(-1).params.idempotencyKey;
  s.owner.onGatewayEvent({ event: 'chat', payload: { runId, state: 'error', errorMessage: 'provider down' } });
  await assert.rejects(p);
  assert.equal(s.owner.list()[0].usedToday, 1);
});

test("acting for someone: this gateway's agent answers their agent as the version shared with them, under their grant", async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }], access: 'restricted', dailyCap: 5 });
  const active = s.activate();
  // Kamil (this gateway, gwK) also uses Houman's main: share sh2, Kamil as requester, Houman's gateway gwH.
  const theirs = { id: 'sh2', as: 'requester', status: 'active', requester: s.people.owner, owner: s.people.requester, agents: [{ id: 'main-guest', name: 'main' }] };
  s.owner.setShares([{ ...active, as: 'owner' }, theirs]);
  const orig = s.owner.request;
  s.owner.request = async (m, p) => (m === 'agents.list'
    ? { agents: [{ id: 'jarvis', name: 'Jarvis' }, { id: 'jarvis-guest', name: 'Jarvis (guest)' }, { id: 'dev', name: 'Dev' }] }
    : orig(m, p));

  assert.equal(s.owner.actingForName('peer:sh2:main-guest'), 'Houman');
  const deltas = [];
  const r = await s.owner.localTurnFor('jarvis', 'peer:sh2:main-guest', { turnId: 'x1', roomId: 'kamils-room', roomTitle: 'Crash', message: 'how did you fix it?' }, { onDelta: d => deltas.push(d) });
  assert.equal(r.state, 'final');
  assert.deepEqual(deltas, ['jar']);
  const create = s.ownerCalls.find(c => c.method === 'sessions.create').params;
  assert.equal(create.agentId, 'jarvis-guest', 'the guest copy, never the real agent');
  assert.equal(create.permissionMode, 'read-only');
  assert.equal(create.category, 'Shared with Houman S');
  const send = s.ownerCalls.find(c => c.method === 'chat.send').params;
  assert.match(send.message, /in your owner's team chat, you are answering Houman S's agent/);
  assert.equal(s.owner.list().find(x => x.id === 'sh1').usedToday, 1, "counts toward Houman's daily cap");

  // An agent not shared with them, an unknown asker, or a share that ended: no run at all.
  assert.equal(await s.owner.localTurnFor('dev', 'peer:sh2:main-guest', { turnId: 'x2', roomId: 'kamils-room', message: 'hi' }), null);
  assert.equal(await s.owner.localTurnFor('jarvis', 'peer:sh9:main-guest', { turnId: 'x3', roomId: 'kamils-room', message: 'hi' }), null);
  s.owner.setShares([theirs]);
  assert.equal(await s.owner.localTurnFor('jarvis', 'peer:sh2:main-guest', { turnId: 'x4', roomId: 'kamils-room', message: 'hi' }), null);
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 1);
});

test('a peer request cannot pick the owner-room note', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis-guest', name: 'Jarvis' }] });
  s.activate();
  const link = await s.req._link('sh1'); // a crafted request straight over the link, not through turn()
  await link.request('turn', { turnId: 't1', agentId: 'jarvis-guest', roomId: 'r', message: 'hi', inOwnerRoom: true }, { timeoutMs: 5000 });
  assert.match(s.ownerCalls.find(c => c.method === 'chat.send').params.message, /you are answering Houman S's team chat/);
});

test('presence: the side that asked keeps a link open, so the side that granted can reach it (room copies)', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  for (let i = 0; i < 20 && !s.req._links.get('sh1')?.ready; i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(s.req._links.get('sh1')?.ready, 'requester dialled without anyone using an agent');
  // The owner can now call the requester over that link (what room.sync does).
  let got = null;
  s.req._links.get('sh1').handle('room.sync', async p => { got = p; return { ok: true }; });
  const res = await s.owner.personRequest('gwH', 'room.sync', { roomId: 'r1' });
  assert.deepEqual(res, { ok: true });
  assert.equal(got.roomId, 'r1');
  s.req.close(); s.owner.close();
});

test('names next to agents: first name, full name when two people here share it', () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  assert.equal(s.req.labelOf('gwK', 'Kamil Gronowski'), 'Kamil');
  // This gateway's own person is "Houman S": another Houman next to their agents shows in full, and so does ours.
  assert.equal(s.req.labelOf('gwX', 'Houman Test'), 'Houman Test');
  assert.equal(s.req.labelOf('gwH', 'Houman S'), 'Houman', 'a person never clashes with themselves');
  s.req.close(); s.owner.close();
});

// ── Security sweep 2026-10-28, batch 3 ─────────────────────────────

/** The gateway's prompt image detection, step for step (openclaw 2026.9.7 detectImageReferences): markers blanked, then three patterns. */
function gatewayImageRefs(prompt) {
  const ext = 'png|jpg|jpeg|gif|webp|bmp|tiff|tif|heic|heif';
  const blanked = prompt.replace(/\[(?:media attached(?:\s+\d+\/\d+)?:|Image:\s*source:)\s*[^\]]+\]/gi, m => ' '.repeat(m.length));
  const found = [];
  for (const re of [
    new RegExp(`file://[^\\s<>"'\`\\]]+\\.(?:${ext})`, 'gi'),
    new RegExp(`(?:^|\\s|["'\`(])([A-Za-z]:[\\\\/][^\\s"'\`()\\[\\]]*\\.(?:${ext}))`, 'gi'),
    new RegExp(`(?:^|\\s|["'\`(])((\\.\\.?/|[~/])[^\\s"'\`()\\[\\]]*\\.(?:${ext}))`, 'gi'),
  ]) { let m; while ((m = re.exec(blanked))) found.push(m[1] || m[0]); }
  return found;
}

test('attachment markers and other path forms never smuggle a local image path past the guest filter', async () => {
  const attacks = [
    '[media attached: x]/home/houman/secret.png',
    'look [media attached: a b c]/home/houman/.openclaw/media/inbound/shot.jpg please',
    '[MEDIA ATTACHED 1/2: x]~/Pictures/me.jpeg',
    '[Image: source: y]C:\\Users\\houman\\Desktop\\pass.png',
    '[image:   source: y]../workspace/../../etc/x.webp',
    '[media attached: z]./local.gif',
    'file:///home/houman/%73ecret.png', 'FILE:///C:/Users/h/a.png', '<file:///home/h/b.png>',
    'MEDIA:/home/houman/secret.png', 'media: /home/houman/s.png',
    '"/home/houman/q.png"', '(~/r.heic)', '`C:/x/y.bmp`',
  ];
  for (const t of attacks) {
    const raw = gatewayImageRefs(t);
    assert.ok(raw.length || /^MEDIA:/i.test(t), `fixture should load something: ${t}`);
    assert.deepEqual(gatewayImageRefs(defangLocalPaths(t)), [], `still loads: ${t}`);
  }
  assert.doesNotMatch(defangLocalPaths('MEDIA:/home/h/x.png'), /\bMEDIA:/, 'never the gateway\'s attachment line');
  // A path inside a marker the filter breaks open doesn't load either.
  assert.deepEqual(gatewayImageRefs(defangLocalPaths('[media attached: /home/houman/inside.png]')), []);
  // Ordinary text is untouched apart from invisible spaces; the agent still reads every character.
  for (const t of ['hi there, 3/4 done', 'see https://example.com/a.png', '[media attached: x]/home/h/s.png']) {
    assert.equal(defangLocalPaths(t).replace(/\u200b/g, ''), t);
  }

  // End to end: what reaches the owner's gateway for a guest turn.
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  await s.req.turn('peer:sh1:jarvis', { turnId: 't1', roomId: 'r', message: '[media attached: x]/home/houman/secret.png describe it' });
  assert.deepEqual(gatewayImageRefs(s.ownerCalls.find(c => c.method === 'chat.send').params.message), []);
});

test('a guest can\'t reuse a turn id: the limit counts turns made here, and stopping sharing aborts every one', async () => {
  const s = setup({ reply: () => null }); // runs never finish by themselves
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 20 });
  s.activate();
  const results = [];
  // The same turn id for other rooms isn't a resend: refused, and it starts no run.
  for (let i = 0; i < 4; i++) results.push(s.req.turn('peer:sh1:jarvis', { turnId: 'same', roomId: `r${i}`, message: 'x' }).catch(e => e));
  results.push(s.req.turn('peer:sh1:jarvis', { turnId: 'other', roomId: 'r9', message: 'x' }).catch(e => e));
  await wait(30);
  const sends = () => s.ownerCalls.filter(c => c.method === 'chat.send').map(c => c.params.idempotencyKey);
  assert.equal(sends().length, 2, 'never more than two guest runs at once, whatever turn ids they claim');
  await assert.rejects(s.req.turn('peer:sh1:jarvis', { turnId: 'third', roomId: 'r8', message: 'x' }), e => e.code === 'busy');

  // Stop sharing: every run that started is aborted, and every turn ends.
  s.owner.revoke('sh1');
  await wait(30);
  const aborted = new Set(s.ownerCalls.filter(c => c.method === 'chat.abort').map(c => c.params.runId));
  for (const runId of sends()) assert.ok(aborted.has(runId), `run ${runId} kept going after "Stop sharing"`);
  const done = await Promise.all(results);
  assert.equal(done.filter(r => r instanceof Error && r.code === 'bad_request').length, 3, 'a reused turn id is refused');
});

test('stop sharing while a guest turn is being sent: it is aborted once it has started', async () => {
  const s = setup({ reply: () => null });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  // A gateway that ignores an abort for a run it hasn't registered yet (the send is still on its way).
  const started = new Set();
  let releaseSend;
  const request = s.owner.request;
  s.owner.request = async (method, params) => {
    if (method === 'chat.send') { await new Promise(r => { releaseSend = r; }); started.add(params.idempotencyKey); return request(method, params); }
    if (method === 'chat.abort' && !started.has(params.runId)) { s.ownerCalls.push({ method, params, ignored: true }); return { ok: true }; }
    return request(method, params);
  };
  const run = s.req.turn('peer:sh1:jarvis', { turnId: 't1', roomId: 'r', message: 'long' }).catch(e => e);
  for (let i = 0; i < 50 && !releaseSend; i++) await wait(5);
  s.owner.revoke('sh1');
  releaseSend();
  await wait(50);
  assert.ok(s.ownerCalls.some(c => c.method === 'chat.abort' && !c.ignored), 'the run survived "Stop sharing"');
  assert.equal(s.owner._runs.size, 0, 'nothing left running on the owner\'s gateway');
  await run;
});

test('a contact\'s key is pinned to their gateway: another share can\'t bring a new key, and only the owner can accept one', () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  const active = s.activate();
  assert.equal(s.req.remoteAgents().length, 1); // pins Kamil's gateway key

  // A server posing as Kamil: a new share "from" his gateway, signed with its own key.
  const evil = keyIn();
  const grant2 = { ...active.grant, shareId: 'sh2', agents: [{ id: 'main', name: 'Main' }] };
  const forged = { ...active, id: 'sh2', owner: { ...active.owner, pubKey: evil.publicKey }, grant: grant2, signature: evil.signJson(grant2) };
  s.req.setShares([{ ...active, as: 'requester' }, { ...forged, as: 'requester' }]);
  assert.deepEqual(s.req.remoteAgents().map(a => a.agentId), ['peer:sh1:jarvis'], 'the second key for gwK is refused');
  assert.equal(s.req.list().find(x => x.id === 'sh2').keyChanged, true);
  assert.deepEqual(s.req.list().find(x => x.id === 'sh2').keyChange, { was: fingerprint(active.owner.pubKey), now: fingerprint(evil.publicKey) });
  assert.equal(s.req.list().find(x => x.id === 'sh1').keyChange, undefined);

  // Owner side: a new request from Houman's gateway carrying another key is refused too.
  s.owner.setShares([{ ...active, as: 'owner' }, { ...active, id: 'sh3', status: 'pending', grant: null, signature: null, requester: { ...active.requester, pubKey: evil.publicKey }, as: 'owner' }]);
  assert.throws(() => s.owner.approve('sh3', { agents: [{ id: 'jarvis', name: 'Jarvis' }] }), /isn't the one you connected with before/);
  assert.equal(s.owner.list().find(x => x.id === 'sh3').keyChanged, true);
  // ...until the owner accepts it (they reinstalled; checked "Their key" with them).
  s.owner.trustNewKey('sh3');
  assert.equal(s.owner.approve('sh3', { agents: [{ id: 'jarvis', name: 'Jarvis' }] }).requesterPubKey, evil.publicKey);
  s.req.trustNewKey('sh2');
  assert.deepEqual(s.req.remoteAgents().map(a => a.agentId), ['peer:sh2:main'], 'trusted: the new key is the one now (the old one no longer is)');
});

test('a grant only counts for the gateway it was signed for (the server can\'t pass one contact off as another)', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  const active = s.activate();
  assert.equal(s.req.contact('gwK')?.name, 'Kamil');
  // The server relabels Kamil's share as coming from another contact's gateway (gwX).
  s.req.setShares([{ ...active, as: 'requester', owner: { ...active.owner, gatewayId: 'gwX', name: 'Xena' } }]);
  assert.equal(s.req.contact('gwX'), null, 'Kamil\'s grant does not make his gateway "gwX"');
  assert.deepEqual(s.req.remoteAgents(), []);
  assert.notEqual(s.req.ownerOf('peer:sh1:jarvis'), 'gwX');
  await assert.rejects(s.req.personRequest('gwX', 'room.fetch', { roomId: 'r' }), /Not connected/);

  // Owner side: a share list that now names another requester gateway doesn't move the grant to it.
  s.owner.setShares([{ ...active, as: 'owner', requester: { ...active.requester, gatewayId: 'gwX' } }]);
  assert.equal(s.owner.contact('gwX'), null);
  assert.equal(s.owner.contact('gwH')?.name, 'Houman S');
});

test('peer requests are rate limited per contact (turns, and everything else), without touching normal use', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 100 });
  s.activate();
  // A normal chat: a handful of replies is fine.
  for (let i = 0; i < 5; i++) await s.req.turn('peer:sh1:jarvis', { turnId: `n${i}`, roomId: 'r', message: 'hi' });
  // A flood of turns: refused past the per-contact rate (20 a minute), before any run.
  const errs = [];
  for (let i = 0; i < 20; i++) await s.req.turn('peer:sh1:jarvis', { turnId: `f${i}`, roomId: 'r', message: 'x' }).catch(e => errs.push(e));
  assert.ok(errs.length >= 4 && errs.every(e => e.code === 'rate_limited'), `${errs.length} refused`);
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 20);
  // Other requests have their own, larger allowance.
  const link = await s.req._link('sh1');
  const other = await Promise.all(Array.from({ length: 130 }, () => link.request('agents', {}).then(() => 'ok', e => e.code)));
  assert.equal(other.filter(r => r === 'ok').length, 120);
  assert.ok(other.slice(120).every(r => r === 'rate_limited'));
});

test('a link that drops mid-turn: the turn is sent again and joins the run still going (one run, counted once)', async () => {
  const s = setup({ reply: () => null });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 10 });
  s.activate();
  const deltas = [];
  const run = s.req.turn('peer:sh1:jarvis', { turnId: 'team-1', roomId: 'r', message: 'hi' }, { onDelta: t => deltas.push(t) });
  await wait(20);
  [...s.owner._served][0].close(); // the DataChannel drops
  await wait(60);
  const sends = s.ownerCalls.filter(c => c.method === 'chat.send');
  assert.equal(sends.length, 1, 'the resend started no second run');
  assert.equal(s.owner._served.size, 1, 'the requester dialled again');
  assert.deepEqual(deltas, ['jar', 'jar'], 'the new link got the text so far');
  s.owner.onGatewayEvent({ event: 'chat', payload: { runId: sends[0].params.idempotencyKey, state: 'final', message: { content: [{ type: 'text', text: 'done' }] } } });
  assert.deepEqual(await run, { state: 'final', text: 'done' });
  assert.equal(s.owner._usage('sh1'), 1, 'counted once');
});

test('a resend of a finished turn gets its result, with no new run; another message under that turn id is refused', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 10 });
  s.activate();
  const turn = { turnId: 'team-2', roomId: 'r', message: 'hi' };
  const first = await s.req.turn('peer:sh1:jarvis', turn);
  assert.deepEqual(await s.req.turn('peer:sh1:jarvis', turn), first);
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 1);
  assert.equal(s.owner._usage('sh1'), 1);
  await assert.rejects(s.req.turn('peer:sh1:jarvis', { ...turn, message: 'something else' }), e => e.code === 'bad_request');
  await assert.rejects(s.req.turn('peer:sh1:jarvis', { ...turn, roomId: 'other' }), e => e.code === 'bad_request');
});

test('another message under a running turn id is refused, and the run goes on', async () => {
  const s = setup({ reply: () => null });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  const run = s.req.turn('peer:sh1:jarvis', { turnId: 'team-3', roomId: 'r', message: 'hi' });
  await wait(20);
  await assert.rejects(s.req.turn('peer:sh1:jarvis', { turnId: 'team-3', roomId: 'r', message: 'changed' }), e => e.code === 'bad_request');
  await s.req.abort('peer:sh1:jarvis', 'team-3');
  assert.deepEqual(await run, { state: 'aborted', text: 'jar' });
});

test('the run id comes from the share and the turn id, so a resend after a restart reuses the idempotency key', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  await s.req.turn('peer:sh1:jarvis', { turnId: 'team-4', roomId: 'r', message: 'hi' });
  await s.req.turn('peer:sh1:jarvis', { roomId: 'r', message: 'no turn id' });
  const keys = s.ownerCalls.filter(c => c.method === 'chat.send').map(c => c.params.idempotencyKey);
  const crypto = await import('node:crypto');
  assert.equal(keys[0], `peer-${crypto.createHash('sha256').update('sh1|team-4').digest('hex').slice(0, 32)}`);
  assert.match(keys[1], /^peer-[0-9a-f-]{36}$/, 'without a turn id it stays random');
});

test('the gateway says the key was used for other input (chat-request-conflict): bad_request', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 10 });
  s.activate();
  const request = s.owner.request;
  s.owner.request = async (method, params) => {
    if (method === 'chat.send') throw Object.assign(new Error('This message ID was already used for different input.'), { gatewayCode: 'INVALID_REQUEST', details: { reason: 'chat-request-conflict' } });
    return request(method, params);
  };
  await assert.rejects(s.req.turn('peer:sh1:jarvis', { turnId: 'team-5', roomId: 'r', message: 'hi' }), e => e.code === 'bad_request');
  assert.equal(s.owner._usage('sh1'), 0, 'a refused turn is not counted');
});

test('after a restart the gateway answers the resend with "ok" (that run already ran): its reply is read from the session', async () => {
  const s = setup();
  let input = null; // in the session once sent
  const sentText = () => input;
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  const request = s.owner.request;
  s.owner.request = async (method, params) => {
    if (method === 'chat.send') { s.ownerCalls.push({ method, params }); input = params.message; return { runId: params.idempotencyKey, status: 'ok' }; }
    if (method === 'chat.history') return { messages: input === null ? [] : [{ role: 'user', content: sentText(params), __openclaw: { idempotencyKey: `${[...s.owner._turns.values()][0]?.runId}:user` } }, { role: 'assistant', content: [{ type: 'text', text: 'the earlier reply' }] }] };
    return request(method, params);
  };
  assert.deepEqual(await s.req.turn('peer:sh1:jarvis', { turnId: 'team-6', roomId: 'r', message: 'hi' }), { state: 'final', text: 'the earlier reply' });
  assert.equal(s.owner._runs.size, 0);
});

test('a room stopped while its link was down: the turn is not sent again', async () => {
  const s = setup({ reply: () => null });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  let stopped = false;
  const run = s.req.turn('peer:sh1:jarvis', { turnId: 'team-7', roomId: 'r', message: 'hi' }, { stopped: () => stopped }).catch(e => e);
  await wait(20);
  stopped = true;
  [...s.owner._served][0].close();
  assert.match((await run).message, /peer link closed/);
  await wait(30);
  assert.equal(s.owner._served.size, 0, 'no new link for it');
  for (const t of s.owner._turns.values()) s.owner._abortTurn(t);
});

test('Stop after a reconnect still finds the turn, and is fenced to the session the run started in', async () => {
  const s = setup({ reply: () => null });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  const request = s.owner.request;
  s.owner.request = async (method, params) => (method === 'sessions.describe' ? { session: { key: params.key, sessionId: 'phys-1' } } : request(method, params));
  const run = s.req.turn('peer:sh1:jarvis', { turnId: 'team-8', roomId: 'r', message: 'hi' });
  await wait(20);
  [...s.owner._served][0].close();
  await wait(60);
  await s.req.abort('peer:sh1:jarvis', 'team-8');
  assert.deepEqual(await run, { state: 'aborted', text: 'jar' });
  const abort = s.ownerCalls.find(c => c.method === 'chat.abort').params;
  assert.equal(abort.sessionId, 'phys-1');
  assert.equal(abort.runId, s.ownerCalls.find(c => c.method === 'chat.send').params.idempotencyKey);
});

/** The owner's gateway after a restart (2026.9.7): it forgot its dedupe, the session still has the turn's input. */
async function restartedOwner(s, { reply, active = false, input = 'hi' }) {
  // What the owner sends for that message (the guest note + the message), from a turn in another room.
  await s.req.turn('peer:sh1:jarvis', { turnId: 'warm-up', roomId: 'r0', message: input });
  const sent = s.ownerCalls.filter(c => c.method === 'chat.send').at(-1).params.message;
  s.ownerCalls.length = 0;
  const request = s.owner.request;
  s.owner.request = async (method, params) => {
    if (method === 'chat.history') {
      const key = s.owner._turns.size && [...s.owner._turns.values()][0].runId;
      return { messages: [
        { role: 'user', content: 'an older turn', __openclaw: { idempotencyKey: 'peer-old:user' } },
        { role: 'assistant', content: [{ type: 'text', text: 'older reply' }] },
        { role: 'user', content: sent, __openclaw: { idempotencyKey: `${key}:user` } },
        ...(reply ? [{ role: 'assistant', content: [{ type: 'text', text: reply }] }] : []),
      ] };
    }
    if (method === 'sessions.describe') return { session: { key: params.key, hasActiveRun: active } };
    return request(method, params);
  };
}

test('a resend after the owner restarted: the turn already ran there, so its reply is returned and nothing runs again', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 10 });
  s.activate();
  await restartedOwner(s, { reply: 'the reply it gave' });
  assert.deepEqual(await s.req.turn('peer:sh1:jarvis', { turnId: 'team-9', roomId: 'r', message: 'hi' }), { state: 'final', text: 'the reply it gave' });
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 0, 'no reply to nothing');
});

test('a resend after only the connector reloaded: the run is still going, so the send joins it and waits for it', async () => {
  const s = setup({ reply: () => 'finished' });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  await restartedOwner(s, { reply: null, active: true });
  assert.deepEqual(await s.req.turn('peer:sh1:jarvis', { turnId: 'team-10', roomId: 'r', message: 'hi' }), { state: 'final', text: 'finished' });
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 1);
});

test('a resend of a turn its restart cut off (input there, no reply, nothing running): failed, not counted', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 10 });
  s.activate();
  await restartedOwner(s, { reply: null });
  s.owner._db().prepare('DELETE FROM peer_usage').run();
  await assert.rejects(s.req.turn('peer:sh1:jarvis', { turnId: 'team-11', roomId: 'r', message: 'hi' }), e => e.code === 'run_failed' && /interrupted/.test(e.message));
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 0);
  assert.equal(s.owner._usage('sh1'), 0);
});

test('a resend after the owner restarted with another message under that turn id: refused, nothing runs', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  await restartedOwner(s, { reply: 'the reply it gave' });
  await assert.rejects(s.req.turn('peer:sh1:jarvis', { turnId: 'team-12', roomId: 'r', message: 'something else' }), e => e.code === 'bad_request');
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 0);
});

test('history caps long messages: the input check and the reply read the whole message (chat.message.get)', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  const long = 'x'.repeat(9000);
  await s.req.turn('peer:sh1:jarvis', { turnId: 'warm-up', roomId: 'r0', message: long });
  const sent = s.ownerCalls.filter(c => c.method === 'chat.send').at(-1).params.message;
  s.ownerCalls.length = 0;
  const full = { u1: sent, a1: `${'y'.repeat(9000)} the end` };
  const cut = t => [{ type: 'text', text: `${t.slice(0, 8000)}\n...(truncated)...` }];
  const request = s.owner.request;
  s.owner.request = async (method, params) => {
    if (method === 'chat.history') {
      const key = [...s.owner._turns.values()][0].runId;
      return { messages: [
        { role: 'user', content: cut(full.u1), __openclaw: { id: 'u1', idempotencyKey: `${key}:user`, truncated: true } },
        { role: 'assistant', content: cut(full.a1), __openclaw: { id: 'a1', truncated: true } },
      ] };
    }
    if (method === 'chat.message.get') return { ok: true, message: { role: 'x', content: [{ type: 'text', text: full[params.messageId] }] } };
    if (method === 'sessions.describe') return { session: { key: params.key, hasActiveRun: false } };
    return request(method, params);
  };
  const r = await s.req.turn('peer:sh1:jarvis', { turnId: 'team-13', roomId: 'r', message: long });
  assert.equal(r.text, full.a1, 'the whole reply, not the capped one');
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 0);
});

test('a resend of a running turn rejoins it even when the share is at its cap or busy; its catch-up text is redacted', async () => {
  const s = setup({ reply: () => null });
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }], dailyCap: 2 });
  s.activate();
  const deltas = [];
  const a = s.req.turn('peer:sh1:jarvis', { turnId: 'a', roomId: 'r1', message: 'x' }, { onDelta: t => deltas.push(t) });
  const b = s.req.turn('peer:sh1:jarvis', { turnId: 'b', roomId: 'r2', message: 'x' }).catch(e => e);
  await wait(20);
  const runA = s.ownerCalls.find(c => c.method === 'chat.send' && /^peer-/.test(c.params.idempotencyKey)).params.idempotencyKey;
  s.owner.onGatewayEvent({ event: 'chat', payload: { runId: runA, state: 'delta', message: { content: [{ type: 'text', text: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }] } } });
  assert.equal(s.owner._usage('sh1'), 2, 'at the cap');
  [...s.owner._served][0].close();
  await wait(60);
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 2, 'no new run');
  assert.ok(deltas.length >= 2 && !/abcdefghijklmnop/.test(deltas.at(-1)), `catch-up delta redacted: ${deltas.at(-1)}`);
  await s.req.abort('peer:sh1:jarvis', 'a'); await s.req.abort('peer:sh1:jarvis', 'b');
  assert.equal((await a).state, 'aborted');
  await b;
});

test('finished turns are kept at most 200, oldest dropped first', () => {
  const s = setup();
  for (let i = 0; i < 205; i++) s.owner._rememberTurn(`sh1|t${i}`, { same: 'x', result: { state: 'final', text: String(i) } });
  assert.equal(s.owner._finished.size, 200);
  assert.equal(s.owner._recentTurn('sh1|t4'), null);
  assert.equal(s.owner._recentTurn('sh1|t5').result.text, '5');
});

/** The owner's gateway restarted mid-run and resumes it (2026.11.x): a run of its own starts after a few polls. */
async function recoveringOwner(s, { finish = true } = {}) {
  await s.req.turn('peer:sh1:jarvis', { turnId: 'warm-up', roomId: 'r0', message: 'hi' });
  const sent = s.ownerCalls.filter(c => c.method === 'chat.send').at(-1).params.message;
  s.ownerCalls.length = 0;
  let polls = 0;
  const request = s.owner.request;
  s.owner.request = async (method, params) => {
    const key = [...s.owner._turns.values()][0]?.runId;
    if (method === 'sessions.describe') {
      s.ownerCalls.push({ method });
      polls++;
      const running = polls >= 3 && (!finish || polls < 6);
      return { session: { key: params.key, sessionId: 'phys-2', hasActiveRun: running, activeRunIds: running ? ['recovery-run'] : [] } };
    }
    if (method === 'chat.history') return { messages: [
      { role: 'user', content: sent, __openclaw: { idempotencyKey: `${key}:user` } },
      ...(polls >= 6 && finish ? [
        { role: 'user', content: 'The Gateway restarted while you were working. Resume your work…', provenance: { kind: 'internal_system', sourceTool: 'restart' } },
        { role: 'assistant', content: [{ type: 'text', text: 'the resumed reply' }] },
      ] : []),
    ] };
    return request(method, params);
  };
}

test("a turn the owner's gateway restart cut off: the gateway's own resumed run is waited for, and its reply returned", async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  await recoveringOwner(s);
  assert.deepEqual(await s.req.turn('peer:sh1:jarvis', { turnId: 'team-14', roomId: 'r', message: 'hi' }), { state: 'final', text: 'the resumed reply' });
  assert.equal(s.ownerCalls.filter(c => c.method === 'chat.send').length, 0, 'not sent again');
});

test('Stop while the gateway resumes a turn: the resumed run is aborted, fenced, and the turn ends aborted', async () => {
  const s = setup();
  s.owner.approve('sh1', { agents: [{ id: 'jarvis', name: 'Jarvis' }] });
  s.activate();
  await recoveringOwner(s, { finish: false });
  const run = s.req.turn('peer:sh1:jarvis', { turnId: 'team-15', roomId: 'r', message: 'hi' });
  await wait(40);
  await s.req.abort('peer:sh1:jarvis', 'team-15');
  assert.deepEqual(await run, { state: 'aborted', text: '' });
  const abort = s.ownerCalls.find(c => c.method === 'chat.abort' && c.params.runId === 'recovery-run')?.params;
  assert.ok(abort, 'the resumed run was aborted');
});
