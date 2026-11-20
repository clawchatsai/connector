// Web Push from the connector itself (not the gateway's push.web.*): RFC 8291 message encryption
// (aes128gcm, RFC 8188) to the browser subscription's keys, VAPID (RFC 8292) authorization, and the
// POST to the push service. Push services only ever see ciphertext. node:crypto only.
import crypto from 'node:crypto';

const RECORD_SIZE = 4096;
// Push services a subscription endpoint may point at (an endpoint is browser-supplied: never POST to anything else).
// Matches the audiences the signal server signs VAPID tokens for (signaling/push-vapid.js).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^(?:[a-z0-9-]+\.)*push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** The push service origin of an endpoint (the VAPID `aud`), or null when it isn't a known push service. */
export function pushAudience(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || !PUSH_HOSTS.some(re => re.test(u.hostname))) return null;
  return u.origin;
}

/** Apple's push service (Safari, iOS home-screen apps): no silent or "clear" pushes there (it revokes the subscription). */
export function isApplePush(endpoint) {
  try { return /(?:^|\.)push\.apple\.com$/.test(new URL(endpoint).hostname); } catch { return false; }
}

/**
 * RFC 8291 §3: encrypt `plaintext` for a subscription ({ p256dh, auth }, base64url). Returns the aes128gcm body.
 * `salt` and `serverKey` (an ECDH object) are for the RFC's test vector only.
 */
export function encryptPayload(keys, plaintext, { salt = crypto.randomBytes(16), serverKey = null } = {}) {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('invalid subscription keys');
  const as = serverKey || crypto.createECDH('prime256v1');
  if (!serverKey) as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // one record, last-record delimiter, no padding
  if (data.length + 16 > RECORD_SIZE) throw new Error('payload too large');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** Public key (base64url, uncompressed point) of a VAPID private key (base64url scalar `d`). */
export function vapidPublicKey(privateKey) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(unb64u(privateKey));
  return b64u(ecdh.getPublicKey());
}

/** An ES256 VAPID JWT for one push service origin (RFC 8292 §2). Used with a local test key; the signal server signs real ones. */
export function signVapidJwt({ audience, subject, privateKey, expiresInSec = 12 * 3600, now = Date.now() }) {
  const pub = unb64u(vapidPublicKey(privateKey));
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + expiresInSec, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

/**
 * POST one encrypted message. Returns { status, retryAfterMs } (status 0: network error). Never throws for HTTP errors;
 * the caller decides (404/410 gone, 413 too big, 429/5xx retry). Errors never carry the endpoint or payload.
 */
export async function postPush(endpoint, body, { jwt, publicKey, ttl, urgency = 'normal', topic, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: `vapid t=${jwt}, k=${publicKey}`,
  };
  if (topic) headers.Topic = topic;
  try {
    const res = await fetchImpl(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, retryAfterMs: retryAfterMs(res.headers?.get?.('retry-after')) };
  } catch {
    return { status: 0, retryAfterMs: null };
  }
}

function retryAfterMs(v) {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** A Topic header value (≤32 base64url chars) for a notification tag: same tag, same topic, so a queued push is replaced. */
export function topicFor(tag) {
  return crypto.createHash('sha256').update(String(tag)).digest('base64url').slice(0, 32);
}
