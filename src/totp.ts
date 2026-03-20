/**
 * totp.ts — RFC 6238 TOTP implementation
 *
 * Generates and verifies 6-digit time-based one-time passwords.
 * No external dependencies — uses Node.js built-in crypto.
 *
 * Spec: datachannel-auth-totp.md §5.2
 */

import * as crypto from 'node:crypto';

const DIGITS = 6;
const PERIOD = 30;
const ALGORITHM = 'sha1';

/**
 * Generate a TOTP code for a given time step.
 */
function generateForStep(secret: Buffer, step: number): string {
  // Convert step to 8-byte big-endian buffer
  const stepBuf = Buffer.alloc(8);
  stepBuf.writeBigUInt64BE(BigInt(step));

  // HMAC-SHA1
  const hmac = crypto.createHmac(ALGORITHM, secret);
  hmac.update(stepBuf);
  const hash = hmac.digest();

  // Dynamic truncation (RFC 4226 §5.4)
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const otp = binary % 10 ** DIGITS;
  return otp.toString().padStart(DIGITS, '0');
}

/**
 * Generate a TOTP code for the current time.
 */
export function generateTotp(secretBase32: string): string {
  const secret = base32Decode(secretBase32);
  const step = Math.floor(Date.now() / 1000 / PERIOD);
  return generateForStep(secret, step);
}

/**
 * Verify a TOTP code with ±1 time-step window and replay prevention.
 *
 * @param code          The 6-digit code from the user
 * @param secretBase32  The base32-encoded TOTP secret
 * @param lastUsedStep  The last successfully used time step (for replay prevention)
 * @returns             The matched time step if valid, or -1 if invalid
 */
export function verifyTotp(
  code: string,
  secretBase32: string,
  lastUsedStep: number,
): number {
  if (!/^\d{6}$/.test(code)) return -1;

  const secret = base32Decode(secretBase32);
  const currentStep = Math.floor(Date.now() / 1000 / PERIOD);

  // Check T-1, T, T+1
  for (const offset of [-1, 0, 1]) {
    const step = currentStep + offset;
    if (step <= lastUsedStep) continue; // replay protection
    const expected = generateForStep(secret, step);
    if (timingSafeEqual(code, expected)) {
      return step; // caller should update lastUsedStep to this value
    }
  }
  return -1;
}

/**
 * Generate a random 20-byte TOTP secret, returned as base32.
 */
export function generateTotpSecret(): string {
  const secret = crypto.randomBytes(20);
  return base32Encode(secret);
}

/**
 * Build an otpauth:// URI for QR code generation.
 */
export function buildOtpauthUri(secretBase32: string, email: string): string {
  const issuer = 'ClawChats';
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Generate backup codes — 10 random 8-char alphanumeric codes.
 * Returns { codes: string[], hashes: string[] }.
 * Display `codes` to the user once. Store `hashes` in config.
 */
export function generateBackupCodes(): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes: string[] = [];
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 ambiguity

  for (let i = 0; i < 10; i++) {
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (let j = 0; j < 8; j++) {
      code += charset[bytes[j] % charset.length];
    }
    // Format as XXXX-XXXX for readability
    const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
    codes.push(formatted);
    hashes.push(crypto.createHash('sha256').update(formatted).digest('hex'));
  }

  return { codes, hashes };
}

/**
 * Verify a backup code against stored hashes. Returns the index consumed, or -1.
 */
export function verifyBackupCode(code: string, hashes: string[]): number {
  const normalized = code.toUpperCase().replace(/\s/g, '');
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  const index = hashes.indexOf(hash);
  return index; // caller should remove hashes[index] after use
}

// ---------------------------------------------------------------------------
// Base32 encoding/decoding (RFC 4648)
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(data: Buffer): string {
  let result = '';
  let bits = 0;
  let value = 0;

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Timing-safe string comparison
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}
