import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function derivePublicKeyRaw(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  return crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex');
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

export function loadOrCreateDeviceIdentity(identityPath) {
  try {
    if (fs.existsSync(identityPath)) {
      const parsed = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
      if (parsed?.version === 1 && parsed.deviceId && parsed.publicKeyPem && parsed.privateKeyPem) return parsed;
    }
  } catch { /* regenerate */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const identity = { version: 1, deviceId: fingerprintPublicKey(publicKeyPem), publicKeyPem, privateKeyPem, createdAtMs: Date.now() };
  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  return identity;
}

export function buildDeviceAuth(identity, { clientId, clientMode, role, scopes, token, nonce }) {
  const signedAt = Date.now();
  const payload = ['v2', identity.deviceId, clientId, clientMode, role, scopes.join(','), String(signedAt), token || '', nonce].join('|');
  const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
  const signature = base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey));
  const publicKeyB64Url = base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem));
  return { id: identity.deviceId, publicKey: publicKeyB64Url, signature, signedAt, nonce };
}
