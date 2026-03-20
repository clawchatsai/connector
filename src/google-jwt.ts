/**
 * google-jwt.ts — Google ID Token verification
 *
 * Verifies Google-signed JWTs against Google's public JWKS.
 * Uses `jose` for cryptographic verification.
 *
 * Spec: datachannel-auth-totp.md §5.1
 */

import * as https from 'node:https';

// jose is imported dynamically to allow graceful failure if not installed
let joseModule: typeof import('jose') | null = null;

async function getJose(): Promise<typeof import('jose')> {
  if (!joseModule) {
    joseModule = await import('jose');
  }
  return joseModule;
}

// ---------------------------------------------------------------------------
// JWKS cache
// ---------------------------------------------------------------------------

interface CachedJWKS {
  keys: unknown;
  expiresAt: number;
}

let jwksCache: CachedJWKS | null = null;
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Fetch Google's JWKS, with caching based on Cache-Control header.
 */
async function fetchJWKS(): Promise<unknown> {
  if (jwksCache && Date.now() < jwksCache.expiresAt) {
    return jwksCache.keys;
  }

  const jose = await getJose();

  return new Promise((resolve, reject) => {
    https.get(GOOGLE_JWKS_URI, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const keys = JSON.parse(data);

          // Parse Cache-Control max-age
          const cacheControl = res.headers['cache-control'] || '';
          const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
          const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 3600;

          jwksCache = {
            keys,
            expiresAt: Date.now() + maxAge * 1000,
          };

          resolve(keys);
        } catch (e) {
          reject(new Error(`Failed to parse Google JWKS: ${(e as Error).message}`));
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface GoogleIdTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  email: string;
  email_verified: boolean;
  exp: number;
  iat: number;
}

export interface VerifyGoogleIdTokenOptions {
  clientId: string;
  authorizedSub: string;
  authorizedEmail: string;
}

/**
 * Verify a Google ID token JWT.
 *
 * @param idToken  The raw JWT string from the browser
 * @param options  Expected clientId, sub, and email
 * @returns        The verified claims, or throws on failure
 */
export async function verifyGoogleIdToken(
  idToken: string,
  options: VerifyGoogleIdTokenOptions,
): Promise<GoogleIdTokenClaims> {
  const jose = await getJose();

  // Fetch JWKS
  const jwksData = await fetchJWKS() as { keys: unknown[] };
  const JWKS = jose.createLocalJWKSet(jwksData as Parameters<typeof jose.createLocalJWKSet>[0]);

  // Verify signature and decode
  const { payload } = await jose.jwtVerify(idToken, JWKS, {
    issuer: GOOGLE_ISSUERS,
    audience: options.clientId,
  });

  const claims = payload as unknown as GoogleIdTokenClaims;

  // Verify sub matches authorized user
  if (claims.sub !== options.authorizedSub) {
    throw new Error(
      `Google account mismatch: expected sub ${options.authorizedSub}, ` +
      `got ${claims.sub} (${claims.email})`
    );
  }

  // Verify email matches (belt + suspenders)
  if (claims.email !== options.authorizedEmail) {
    throw new Error(
      `Google email mismatch: expected ${options.authorizedEmail}, got ${claims.email}`
    );
  }

  return claims;
}

/**
 * Invalidate the JWKS cache (e.g., on key rotation failure).
 */
export function clearJWKSCache(): void {
  jwksCache = null;
}
