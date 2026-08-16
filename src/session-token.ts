/**
 * session-token.ts — Plugin-local session JWT management
 *
 * Issues and verifies HS256 JWTs that let returning users skip TOTP.
 * Signing key is stored in config.json — regenerating it invalidates
 * all previously issued tokens.
 *
 * Spec: datachannel-auth-totp.md §6
 */

import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// HS256 JWT implementation (minimal, no dependencies)
// ---------------------------------------------------------------------------

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

interface SessionPayload {
  sub: string;         // userId
  googleSub?: string;  // Google account sub — absent on a gateway paired without Google
  iat: number;         // issued at (unix seconds)
  exp: number;         // expiry (unix seconds)
  jti: string;         // unique token ID
}

/**
 * Issue a session token.
 *
 * @param userId      The ClawChats user ID
 * @param googleSub   The Google account sub
 * @param sessionDays Duration in days (1-30, clamped)
 * @param secret      The 256-bit hex signing key from config
 * @returns           The signed JWT string
 */
export function issueSessionToken(
  userId: string,
  googleSub: string | undefined,
  sessionDays: number,
  secret: string,
): string {
  const days = Math.min(Math.max(Math.round(sessionDays), 1), 30);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: SessionPayload = {
    sub: userId,
    googleSub,
    iat: now,
    exp: now + days * 86400,
    jti: crypto.randomUUID(),
  };

  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'hex'));
  hmac.update(signingInput);
  const signature = hmac.digest().toString('base64url');

  return `${signingInput}.${signature}`;
}

/**
 * Verify a session token.
 *
 * @param token       The JWT string from the browser
 * @param secret      The 256-bit hex signing key from config
 * @param userId      Expected userId
 * @param googleSub   Expected Google sub
 * @returns           The decoded payload if valid
 * @throws            Error with descriptive message on failure
 */
export function verifySessionToken(
  token: string,
  secret: string,
  userId: string,
  googleSub: string | undefined,
): SessionPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed_token');

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'hex'));
  hmac.update(signingInput);
  const expectedSig = hmac.digest();
  const actualSig = base64urlDecode(signatureB64);

  if (expectedSig.length !== actualSig.length ||
      !crypto.timingSafeEqual(expectedSig, actualSig)) {
    throw new Error('invalid_signature');
  }

  // Decode payload
  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    throw new Error('malformed_payload');
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error('expired_session');

  // Check not issued in the future (clock skew tolerance: 60s)
  if (payload.iat > now + 60) throw new Error('invalid_iat');

  // Check identity
  if (payload.sub !== userId) throw new Error('invalid_user');
  if (payload.googleSub !== googleSub) throw new Error('invalid_google_sub');

  return payload;
}

/**
 * Generate a new 256-bit session secret (hex-encoded).
 * Call this during initial setup and on `reauth` to invalidate all sessions.
 */
export function generateSessionSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
