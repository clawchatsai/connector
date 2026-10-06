// Decrypts a ClawChats share envelope. Inlined into every share page by viewer-page.js (the `export`
// keywords are stripped there), and imported directly by the tests. Mirrors the browser's encrypt side
// (clawchats frontend/share/share-crypto.js). No DOM use.

const b64uDecode = s => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
};

export class ShareError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function keyFromLinkSecret(secret) {
  const raw = b64uDecode(secret);
  if (raw.length !== 32) throw new ShareError('bad-key', 'This link is incomplete. Copy the full link, including the part after #.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

async function keyFromPassword(password, kdf) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: kdf.hash, iterations: kdf.iter, salt: b64uDecode(kdf.salt) },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

/** True when the envelope needs a password instead of the link secret. */
export const needsPassword = envelope => !!envelope.kdf;

/**
 * @param {object} envelope  {v, alg, kdf?, iv, ct}
 * @param {{secret?: string, password?: string}} opts
 * @returns {Promise<object>} the shared payload
 */
export async function decryptShare(envelope, { secret, password } = {}) {
  if (envelope?.v !== 1 || envelope.alg !== 'A256GCM') throw new ShareError('unsupported', 'This share was made by a newer version of ClawChats.');
  const key = envelope.kdf
    ? await keyFromPassword(password ?? '', envelope.kdf)
    : await keyFromLinkSecret(secret ?? '');
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uDecode(envelope.iv) }, key, b64uDecode(envelope.ct));
  } catch {
    throw new ShareError(envelope.kdf ? 'bad-password' : 'bad-key',
      envelope.kdf ? 'Wrong password.' : 'This link’s key doesn’t match. Copy the full link again.');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}
