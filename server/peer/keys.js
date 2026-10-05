// Peer identity of this connector for gateway sharing (specs/gateway-sharing.md in clawchats):
// an Ed25519 key pair whose private half never leaves this machine. The public key goes to the
// signal server with gateway-auth; the other side pins it when a share is approved.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** JSON with sorted keys: what both sides sign and verify (same as the signal server's). */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function verifySignature(pubB64, data, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(pubB64), 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || typeof sigB64 !== 'string') return false;
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

/** Short, comparable fingerprint of a public key (same format as the signal server shows). */
export function fingerprint(pubB64) {
  const h = crypto.createHash('sha256').update(Buffer.from(String(pubB64 || ''), 'base64')).digest('hex').slice(0, 20);
  return h.match(/.{4}/g).join('-');
}

/** Load the key pair from `<dataDir>/peer-key.json`, creating it (mode 0600) on first use. */
export function loadOrCreatePeerKey(dataDir) {
  const file = path.join(dataDir, 'peer-key.json');
  let privateKey;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    privateKey = crypto.createPrivateKey({ key: Buffer.from(saved.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }), { mode: 0o600 });
  }
  const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    publicKey,
    fingerprint: fingerprint(publicKey),
    sign: data => crypto.sign(null, Buffer.from(data), privateKey).toString('base64'),
    signJson: obj => crypto.sign(null, Buffer.from(canonicalJson(obj)), privateKey).toString('base64'),
  };
}
