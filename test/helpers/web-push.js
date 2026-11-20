// A browser's side of Web Push for tests: a subscription's keys, and RFC 8291 decryption.
import crypto from 'node:crypto';

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

/** RFC 8291 decryption, as a browser does it (the test's user agent). */
export function decryptPayload(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdhSecret = uaEcdh.computeSecret(asPublic);
  const ikm = hmac(hmac(authSecret, ecdhSecret), Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

export function fakeSubscription() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ua, auth, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}
