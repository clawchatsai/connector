/**
 * channel-binding.ts — what the connector and a browser sign to log in over a DataChannel
 *
 * The signaling server brokers the WebRTC connection and is not trusted. Both sides therefore
 * sign a transcript that contains the DTLS fingerprints each of them sees in the SDP. A relay
 * that terminates DTLS separately towards each side sees different fingerprints on each leg, so a
 * signature made on one leg does not verify on the other.
 *
 * The browser has the same code (frontend/connection/device-auth.js). tests pin both to the same
 * test vectors; change them together and bump AUTH_DOMAIN.
 *
 * Spec: specs/device-keys-auth.md (clawchats repo)
 */

import * as crypto from 'node:crypto';
// @ts-expect-error — server/ is plain JS with no .d.ts
import { verifySignature, fingerprint as keyFingerprint, fingerprintWords } from '../server/peer/keys.js';

/** Protocol version announced in auth-required. 1 (no field) = the old session-token login. */
export const AUTH_VERSION = 2;
/** Domain separation: a signature made for anything else never verifies here, and the reverse. */
export const AUTH_DOMAIN = 'clawchats-auth-v2';

export type SignRole = 'connector' | 'device' | 'pair';

/** What both sides know about one channel. Fingerprints are 64 upper-case hex digits. */
export interface ChannelBinding {
  /** Random per channel, chosen by the connector. */
  nonce: string;
  /** The signaling server's connection id (a label: both sides must agree on it). */
  connectionId: string;
  /** DTLS fingerprint of the browser's certificate: the one in the browser's offer. */
  browserFp: string;
  /** DTLS fingerprint of the connector's certificate: the one in the connector's answer. */
  connectorFp: string;
  /** The connector's Ed25519 public key (SPKI, base64). */
  connectorPub: string;
}

/**
 * The single `a=fingerprint:sha-256` of an SDP as 64 upper-case hex digits; "" unless there is
 * exactly one distinct value (no fingerprint, or two to choose from, cannot be bound to).
 */
export function sdpFingerprint(sdp: string | undefined | null): string {
  const found = new Set<string>();
  for (const m of String(sdp || '').matchAll(/^a=fingerprint:sha-256[ \t]+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31})[ \t]*\r?$/gm)) {
    found.add(m[1].replace(/:/g, '').toUpperCase());
  }
  return found.size === 1 ? [...found][0] : '';
}

/** The exact string that gets signed. A JSON array of strings: no field can run into the next. */
export function transcript(role: SignRole, b: ChannelBinding, devicePub = '', label = ''): string {
  return JSON.stringify([AUTH_DOMAIN, role, b.nonce, b.connectionId, b.browserFp, b.connectorFp, b.connectorPub, devicePub, label]);
}

/** Id of a device key: first 16 bytes of SHA-256 over its SPKI, hex. Derived, so no one can claim another's. */
export function deviceIdOf(devicePub: string): string {
  return crypto.createHash('sha256').update(Buffer.from(devicePub, 'base64')).digest('hex').slice(0, 32);
}

/** Does `sig` (base64) sign `data` under the Ed25519 key `pub` (SPKI, base64)? */
export function verifyEd25519(pub: string, data: string, sig: string): boolean {
  return typeof pub === 'string' && typeof sig === 'string' && !!verifySignature(pub, data, sig);
}

/** Is this a well-formed Ed25519 SPKI public key (base64)? */
export function isEd25519Spki(pub: unknown): pub is string {
  if (typeof pub !== 'string' || pub.length > 128) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && Buffer.from(pub, 'base64').toString('base64') === pub;
  } catch { return false; }
}

/** Short comparable fingerprint of a public key, same format as the sharing keys: `abcd-ef01-…` (5 groups). */
export const publicKeyFingerprint: (pub: string) => string = keyFingerprint;

/** The same key as four words (what pairing screens show first); see server/peer/keys.js. */
export const publicKeyWords: (pub: string) => string = fingerprintWords;

/**
 * Proof that the sender knew the one-time code, tied to this channel and device key. The code
 * itself is never sent. Key = the 6 digits (TOTP) or the stored hash of the backup code.
 * A relay without the code cannot make one; one with the proof can still try all 10^6 codes
 * offline, so this is a binding, not a PAKE (see the spec's residual risks).
 */
export function pairProof(key: string, message: string): string {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

/** Constant-time comparison of two hex proofs. */
export function proofEquals(a: string, b: string): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length
    && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
