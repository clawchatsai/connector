import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptPayload, signVapidJwt, vapidPublicKey, pushAudience, isApplePush, postPush, topicFor } from './web-push.js';
import { VapidTokens, localVapid } from './vapid.js';
import { decryptPayload, fakeSubscription } from '../../test/helpers/web-push.js';

test('RFC 8291 appendix A test vector', () => {
  const as = crypto.createECDH('prime256v1');
  as.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const body = encryptPayload(
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    'When I grow up, I want to be a watermelon',
    { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), serverKey: as },
  );
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('a payload round-trips through a fresh key pair, and a different one each time', () => {
  const s = fakeSubscription();
  const msg = JSON.stringify({ title: 'Chat', body: 'é ✓ '.repeat(100) });
  const a = encryptPayload(s.keys, msg), b = encryptPayload(s.keys, msg);
  assert.notDeepEqual(a, b);
  assert.equal(decryptPayload(a, s.ua, s.auth), msg);
  assert.throws(() => encryptPayload({ p256dh: 'AAAA', auth: s.keys.auth }, 'x'), /invalid subscription keys/);
  assert.throws(() => encryptPayload(s.keys, 'x'.repeat(5000)), /too large/);
});

test('VAPID JWT: ES256 over aud/exp/sub, verifiable with the public key', () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const d = ecdh.getPrivateKey().toString('base64url');
  const pub = vapidPublicKey(d);
  assert.equal(pub, ecdh.getPublicKey().toString('base64url'));
  const jwt = signVapidJwt({ audience: 'https://fcm.googleapis.com', subject: 'mailto:a@b.c', privateKey: d, now: 1_000_000 });
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: 1000 + 12 * 3600, sub: 'mailto:a@b.c' });
  const raw = Buffer.from(pub, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('only known push services are endpoints; Apple is told apart', () => {
  assert.equal(pushAudience('https://fcm.googleapis.com/fcm/send/abc'), 'https://fcm.googleapis.com');
  assert.equal(pushAudience('https://web.push.apple.com/QGx'), 'https://web.push.apple.com');
  assert.equal(pushAudience('https://updates.push.services.mozilla.com/wpush/v2/x'), 'https://updates.push.services.mozilla.com');
  assert.equal(pushAudience('https://wns2-par02p.notify.windows.com/w/?token=x'), 'https://wns2-par02p.notify.windows.com');
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com:8443/x', 'nope']) assert.equal(pushAudience(bad), null, bad);
  assert.ok(isApplePush('https://web.push.apple.com/x'));
  assert.ok(!isApplePush('https://fcm.googleapis.com/x'));
});

test('postPush sends the RFC 8030/8292 headers and reads Retry-After', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { status: 429, headers: new Map([['retry-after', '7']]) }; };
  const r = await postPush('https://fcm.googleapis.com/x', Buffer.from('ct'), { jwt: 'J', publicKey: 'K', ttl: 60, urgency: 'high', topic: topicFor('chat-a'), fetchImpl });
  assert.deepEqual(r, { status: 429, retryAfterMs: 7000 });
  assert.equal(seen.init.headers.Authorization, 'vapid t=J, k=K');
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.init.headers.TTL, '60');
  assert.equal(seen.init.headers.Urgency, 'high');
  assert.match(seen.init.headers.Topic, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(await postPush('https://fcm.googleapis.com/x', Buffer.from(''), { jwt: 'J', publicKey: 'K', ttl: 1, fetchImpl: async () => { throw new Error('ECONNRESET https://fcm…'); } }), { status: 0, retryAfterMs: null });
});

test('VAPID tokens are cached per push service and renewed an hour before they expire', async () => {
  let now = 0, calls = [];
  const v = new VapidTokens({ now: () => now, fetchToken: async aud => { calls.push(aud); return { jwt: `j${calls.length}`, exp: now / 1000 + 12 * 3600, publicKey: 'K' }; } });
  assert.equal((await v.get('https://a')).jwt, 'j1');
  assert.equal((await v.get('https://a')).jwt, 'j1');
  await Promise.all([v.get('https://b'), v.get('https://b')]);
  assert.deepEqual(calls, ['https://a', 'https://b']);
  now = 10.5 * 3600_000;
  assert.equal((await v.get('https://a')).jwt, 'j1');
  now = 11.5 * 3600_000;
  assert.equal((await v.get('https://a')).jwt, 'j3');
  v.drop('https://a');
  assert.equal((await v.get('https://a')).jwt, 'j4');
});

test('a local test key signs tokens whose public half matches', async () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const l = localVapid({ privateKey: ecdh.getPrivateKey().toString('base64url') });
  const t = await l.fetchToken('https://fcm.googleapis.com');
  assert.equal(t.publicKey, l.publicKey);
  assert.ok(t.exp > Date.now() / 1000 + 11 * 3600);
});
