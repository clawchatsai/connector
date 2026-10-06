import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../bootstrap/native.js';
import { SharingManager } from './sharing.js';
import { loadOrCreatePeerKey } from './keys.js';

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
function setup({ reply = p => `jarvis says: ${p.message.split('\n\n').pop()}` } = {}) {
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
    if (method === 'chat.abort') { setImmediate(() => owner.onGatewayEvent({ event: 'chat', payload: { runId: params.runId, state: 'aborted' } })); return { ok: true }; }
    return { ok: true };
  };
  const ownerDb = new Database(':memory:'), reqDb = new Database(':memory:');
  owner = new SharingManager({ getDb: () => ownerDb, request: ownerRequest, key: kOwner, gatewayId: () => 'gwK', signal: m => ownerSignals.push(m), openPeer: async () => { throw new Error('owner never dials'); }, log: quiet });
  const req = new SharingManager({
    getDb: () => reqDb, request: async () => ({}), key: kReq, gatewayId: () => 'gwH', signal: m => reqSignals.push(m), log: quiet,
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
  assert.deepEqual(create.toolOverrides, { webSearch: false });
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
