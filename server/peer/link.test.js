import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeerLink, sdpFingerprint } from './link.js';
import { loadOrCreatePeerKey, canonicalJson, verifySignature, fingerprint } from './keys.js';

const quiet = { warn() {} };

/** Two connected fake DataChannels (async delivery, like the real one). */
function pair() {
  const mk = () => ({ handlers: [], closed: [], other: null, open: true,
    send(s) { if (this.open && this.other.open) setImmediate(() => this.other.handlers.forEach(h => h(s))); },
    close() { if (!this.open) return; this.open = false; this.closed.forEach(h => h()); this.other.close(); },
    onMessage(h) { this.handlers.push(h); }, onClosed(h) { this.closed.push(h); } });
  const a = mk(), b = mk(); a.other = b; b.other = a;
  return [a, b];
}
const keyIn = () => loadOrCreatePeerKey(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-')));
const until = (emitter, ev) => new Promise(r => emitter.once(ev, r));

test('keys: created once with 0600, reloaded, signatures verify', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-'));
  const k1 = loadOrCreatePeerKey(dir), k2 = loadOrCreatePeerKey(dir);
  assert.equal(k1.publicKey, k2.publicKey);
  assert.equal(fs.statSync(path.join(dir, 'peer-key.json')).mode & 0o777, 0o600);
  const sig = k1.signJson({ b: 1, a: [2, { z: 1, y: 2 }] });
  assert.ok(verifySignature(k1.publicKey, canonicalJson({ a: [2, { y: 2, z: 1 }], b: 1 }), sig));
  assert.ok(!verifySignature(keyIn().publicKey, canonicalJson({ a: [2, { y: 2, z: 1 }], b: 1 }), sig));
  assert.match(fingerprint(k1.publicKey), /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
  assert.equal(sdpFingerprint('v=0\r\na=fingerprint:sha-256 ab:CD:01\r\n'), 'AB:CD:01');
});

function linkPair({ ownerSeesKey, requesterSeesKey, dtlsA = { local: 'FA', remote: 'FB' }, dtlsB = { local: 'FB', remote: 'FA' } } = {}) {
  const kr = keyIn(), ko = keyIn();
  const [dr, downer] = pair();
  const req = new PeerLink({ dc: dr, role: 'requester', shareId: 'sh1', key: kr, peerKey: requesterSeesKey ?? ko.publicKey, dtls: dtlsA, log: quiet, handshakeMs: 2000 });
  const own = new PeerLink({ dc: downer, role: 'owner', shareId: 'sh1', key: ko, peerKey: ownerSeesKey ?? kr.publicKey, dtls: dtlsB, log: quiet, handshakeMs: 2000 });
  return { req, own, kr, ko };
}

test('handshake: both sides ready; requests, progress events and errors flow', async () => {
  const { req, own } = linkPair();
  own.handle('turn', async (p, emit) => { emit('delta', 'hel'); emit('delta', 'hello'); return { text: `${p.msg}!` }; });
  own.handle('boom', async () => { throw Object.assign(new Error('nope'), { code: 'cap' }); });
  await Promise.all([until(req, 'ready'), until(own, 'ready')]);
  const events = [];
  assert.deepEqual(await req.request('turn', { msg: 'hi' }, { onEvent: (e, d) => events.push([e, d]) }), { text: 'hi!' });
  assert.deepEqual(events, [['delta', 'hel'], ['delta', 'hello']]);
  await assert.rejects(req.request('boom'), e => e.code === 'cap' && /nope/.test(e.message));
  await assert.rejects(req.request('missing'), e => e.code === 'unknown_method');
  // owner can't call requester methods it doesn't serve, and requests fail once closed
  req.close();
  await assert.rejects(req.request('turn', {}), /not ready/);
});

/** First failure reason from either side, and whether both ended closed and never both ready. */
function outcome(req, own) {
  const reasons = [];
  req.on('failed', r => reasons.push(`requester: ${r}`));
  own.on('failed', r => reasons.push(`owner: ${r}`));
  return Promise.all([until(req, 'closed'), until(own, 'closed')]).then(() => ({ reasons, bothReady: req.ready && own.ready }));
}

test('handshake fails with the wrong pinned key (impersonation)', async () => {
  const { req, own } = linkPair({ ownerSeesKey: keyIn().publicKey });
  const r = await outcome(req, own);
  assert.deepEqual(r.reasons, ['owner: peer signature did not verify']);
  assert.equal(own.ready, false); // the owner never served anything
  assert.equal(r.bothReady, false);
});

test('handshake fails when a relay swapped the DTLS fingerprints (man in the middle)', async () => {
  // Each side sees a different fingerprint for the other (the relay's), so signed views disagree.
  const { req, own } = linkPair({ dtlsA: { local: 'FA', remote: 'MITM1' }, dtlsB: { local: 'FB', remote: 'MITM2' } });
  const r = await outcome(req, own);
  assert.ok(r.reasons.length >= 1 && r.reasons.every(x => /signature did not verify/.test(x)));
  assert.equal(own.ready, false);
});

test('a requester that turns ready first still gets nothing from an owner that rejected it', async () => {
  const { req, own } = linkPair({ ownerSeesKey: keyIn().publicKey });
  let served = false;
  own.handle('turn', async () => { served = true; return {}; });
  await until(req, 'ready').catch(() => {});
  await assert.rejects(req.request('turn', {}));
  assert.equal(served, false);
});

test('a peer that never authenticates is dropped; frames before auth are refused', async () => {
  const kr = keyIn();
  const [dr, dx] = pair();
  const req = new PeerLink({ dc: dr, role: 'requester', shareId: 'sh1', key: kr, peerKey: keyIn().publicKey, log: quiet, handshakeMs: 100 });
  assert.match(await until(req, 'failed'), /timed out/);
  const [d1, d2] = pair();
  const r2 = new PeerLink({ dc: d1, role: 'requester', shareId: 'sh1', key: kr, peerKey: keyIn().publicKey, log: quiet });
  d2.send(JSON.stringify({ t: 'req', id: 'x', method: 'turn', params: {} }));
  assert.match(await until(r2, 'failed'), /before auth/);
  void dx;
});
