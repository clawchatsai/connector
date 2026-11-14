// The wire format both sides must agree on. frontend tests/unit/device-auth.test.mjs has the same vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcript, sdpFingerprint, deviceIdOf, publicKeyFingerprint, isEd25519Spki, pairProof } from '../dist/channel-binding.js';

const B = { nonce: 'n'.repeat(4), connectionId: 'conn_1', browserFp: 'AA', connectorFp: 'BB', connectorPub: 'CPUB' };

test('transcript vectors (shared with the frontend)', () => {
  assert.equal(transcript('connector', B), '["clawchats-auth-v2","connector","nnnn","conn_1","AA","BB","CPUB","",""]');
  assert.equal(transcript('device', B, 'DPUB'), '["clawchats-auth-v2","device","nnnn","conn_1","AA","BB","CPUB","DPUB",""]');
  assert.equal(transcript('pair', B, 'DPUB', 'My "laptop"\n'), '["clawchats-auth-v2","pair","nnnn","conn_1","AA","BB","CPUB","DPUB","My \\"laptop\\"\\n"]');
  assert.equal(pairProof('123456', 'x'), '488e216d9b16fb72c64ddb299768ef82578ec3c79d6487f039106215df8579b8');
});

test('sdpFingerprint: exactly one sha-256 value, any case, normalised; anything else is empty', () => {
  const fp = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
  const hex = fp.replace(/:/g, '');
  assert.equal(sdpFingerprint(`v=0\r\na=fingerprint:sha-256 ${fp}\r\na=setup:actpass\r\n`), hex);
  assert.equal(sdpFingerprint(`a=fingerprint:sha-256 ${fp.toLowerCase()}\n`), hex);
  assert.equal(sdpFingerprint(`a=fingerprint:sha-256 ${fp}\r\nm=application\r\na=fingerprint:sha-256 ${fp}\r\n`), hex, 'same value twice (session and media level)');
  assert.equal(sdpFingerprint(`a=fingerprint:sha-256 ${fp}\r\na=fingerprint:sha-256 ${fp.replace('AB', '00')}\r\n`), '', 'two different values');
  assert.equal(sdpFingerprint('a=fingerprint:sha-1 AB:CD\r\n'), '');
  assert.equal(sdpFingerprint('a=fingerprint:sha-256 AB:CD\r\n'), '', 'too short');
  assert.equal(sdpFingerprint(`a=fingerprint:sha-256 ${fp}zz\r\n`), '');
  assert.equal(sdpFingerprint(undefined), '');
});

test('key fingerprint and device id formats', () => {
  const pub = 'MCowBQYDK2VwAyEA2L83RxRxq47nHoEvZrvuqQCMFS52DKurdUACJdREIj8=';
  assert.ok(isEd25519Spki(pub));
  assert.ok(!isEd25519Spki(pub.slice(0, -4)));
  assert.ok(!isEd25519Spki('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE'));
  assert.equal(deviceIdOf(pub), 'f135f615eca61060782bf8cc8fdd665d');
  assert.equal(publicKeyFingerprint(pub), 'f135-f615-eca6-1060-782b');
});
