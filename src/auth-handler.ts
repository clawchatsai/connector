/**
 * auth-handler.ts — DataChannel authentication state machine
 *
 * Manages the auth flow for each DataChannel connection:
 * 1. Send auth-required with nonce
 * 2. Wait for auth-session (cached JWT) or auth-full (Google + TOTP)
 * 3. Verify credentials
 * 4. Issue session token on success
 * 5. Block all non-auth messages until authenticated
 *
 * Spec: datachannel-auth-totp.md §4
 */

import * as crypto from 'node:crypto';
import { verifyTotp, verifyBackupCode } from './totp.js';
import { verifyGoogleIdToken, clearJWKSCache } from './google-jwt.js';
import { issueSessionToken, verifySessionToken } from './session-token.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthConfig {
  userId: string;
  totp: {
    secret: string;
    algorithm: string;
    digits: number;
    period: number;
    enabledAt: string;
  };
  google: {
    clientId: string;
    authorizedSub: string;
    authorizedEmail: string;
  };
  sessionSecret: string;
  backupCodeHashes?: string[];
  /** When true, skip Google ID token verification (accept 'dev-mode-no-google'). */
  devMode?: boolean;
}

export interface DataChannelSend {
  send: (data: string) => void;
}

type AuthState = 'awaiting-auth' | 'authenticated' | 'failed';

interface AuthSession {
  state: AuthState;
  nonce: string;
  connectionId: string;
  failCount: number;
  createdAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Tracks per-connection auth state */
const authSessions = new Map<string, AuthSession>();

/** Rate limiting: connectionIds blocked after too many failures */
const blockedConnections = new Map<string, number>(); // connectionId → unblock timestamp

/** TOTP replay prevention */
let lastUsedTotpStep = 0;

/** Max nonces to prevent memory leaks from connection storms */
const MAX_PENDING_NONCES = 10;

const AUTH_TIMEOUT_MS = 60_000; // 60s — enough time to open authenticator app and enter code
const MAX_FAILURES = 5;
const BLOCK_DURATION_MS = 60_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize auth for a new DataChannel connection.
 * Sends auth-required and starts the timeout.
 *
 * @returns true if auth was initiated, false if connection is blocked
 */
export function initAuth(
  dc: DataChannelSend,
  connectionId: string,
): boolean {
  // Check if this connection is rate-limited
  const blockedUntil = blockedConnections.get(connectionId);
  if (blockedUntil && Date.now() < blockedUntil) {
    dc.send(JSON.stringify({
      type: 'auth-failed',
      reason: 'rate_limited',
    }));
    return false;
  }
  blockedConnections.delete(connectionId);

  // Cap pending nonces to prevent memory leaks
  if (authSessions.size >= MAX_PENDING_NONCES) {
    // Evict oldest
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, session] of authSessions) {
      if (session.createdAt < oldestTime) {
        oldestTime = session.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const old = authSessions.get(oldestKey)!;
      clearTimeout(old.timeoutHandle);
      authSessions.delete(oldestKey);
    }
  }

  const nonce = crypto.randomBytes(32).toString('hex');

  const timeoutHandle = setTimeout(() => {
    const session = authSessions.get(connectionId);
    if (session && session.state === 'awaiting-auth') {
      dc.send(JSON.stringify({
        type: 'auth-failed',
        reason: 'auth_timeout',
      }));
      authSessions.delete(connectionId);
    }
  }, AUTH_TIMEOUT_MS);

  authSessions.set(connectionId, {
    state: 'awaiting-auth',
    nonce,
    connectionId,
    failCount: 0,
    createdAt: Date.now(),
    timeoutHandle,
  });

  dc.send(JSON.stringify({
    type: 'auth-required',
    nonce,
  }));

  return true;
}

/**
 * Handle an incoming message on an auth-gated DataChannel.
 *
 * @returns 'authenticated' if the message was an auth message and auth succeeded,
 *          'pending' if auth is still in progress,
 *          'pass' if the connection is already authenticated (message should be processed normally),
 *          'blocked' if the message was dropped (pre-auth non-auth message)
 */
export async function handleAuthMessage(
  dc: DataChannelSend,
  connectionId: string,
  msg: Record<string, unknown>,
  config: AuthConfig,
): Promise<'authenticated' | 'pending' | 'pass' | 'blocked'> {
  const session = authSessions.get(connectionId);

  // No auth session = already authenticated or unknown connection
  if (!session) {
    return 'pass';
  }

  // Already authenticated (shouldn't happen, but be safe)
  if (session.state === 'authenticated') {
    clearTimeout(session.timeoutHandle);
    authSessions.delete(connectionId);
    return 'pass';
  }

  // Only accept auth messages pre-auth
  const msgType = msg['type'] as string;
  if (msgType !== 'auth-session' && msgType !== 'auth-full') {
    return 'blocked';
  }

  // Handle auth-session (cached JWT)
  if (msgType === 'auth-session') {
    const token = msg['sessionToken'] as string;
    if (!token) {
      return sendFailure(dc, connectionId, 'invalid_session');
    }

    try {
      verifySessionToken(
        token,
        config.sessionSecret,
        config.userId,
        config.google.authorizedSub,
      );
      return authSuccess(dc, connectionId);
    } catch (e) {
      const reason = (e as Error).message as string;
      // On expired session, don't count as failure — just prompt for full auth
      if (reason === 'expired_session') {
        dc.send(JSON.stringify({ type: 'auth-failed', reason: 'expired_session' }));
        return 'pending';
      }
      return sendFailure(dc, connectionId, 'invalid_session');
    }
  }

  // Handle auth-full (Google ID token + TOTP)
  if (msgType === 'auth-full') {
    const idToken = msg['idToken'] as string;
    const totp = msg['totp'] as string;
    const sessionDays = msg['sessionDays'] as number || 7;
    const msgNonce = msg['nonce'] as string;

    // Verify nonce
    if (msgNonce !== session.nonce) {
      return sendFailure(dc, connectionId, 'nonce_mismatch');
    }

    // Verify Google ID token (skipped when not configured or in dev mode)
    const skipGoogle = !config.google.clientId || config.google.clientId === 'dev-placeholder'
      || idToken === 'signaling-verified'
      || (config.devMode && idToken === 'dev-mode-no-google');
    if (skipGoogle) {
      console.log('[Auth] Skipping Google ID token verification (not configured)');
    } else {
      try {
        await verifyGoogleIdToken(idToken, {
          clientId: config.google.clientId,
          authorizedSub: config.google.authorizedSub,
          authorizedEmail: config.google.authorizedEmail,
        });
      } catch (e) {
        console.error(`[Auth] Google ID token verification failed: ${(e as Error).message}`);
        // Retry with fresh JWKS on first failure (key rotation)
        clearJWKSCache();
        try {
          await verifyGoogleIdToken(idToken, {
            clientId: config.google.clientId,
            authorizedSub: config.google.authorizedSub,
            authorizedEmail: config.google.authorizedEmail,
          });
        } catch {
          return sendFailure(dc, connectionId, 'invalid_id_token');
        }
      }
    }

    // Verify TOTP or backup code
    const totpStep = verifyTotp(totp, config.totp.secret, lastUsedTotpStep);
    if (totpStep >= 0) {
      lastUsedTotpStep = totpStep;
    } else {
      // Try backup code
      const backupIndex = config.backupCodeHashes
        ? verifyBackupCode(totp, config.backupCodeHashes)
        : -1;

      if (backupIndex >= 0) {
        // Consume the backup code
        config.backupCodeHashes!.splice(backupIndex, 1);
        // Caller should persist the updated config
      } else {
        return sendFailure(dc, connectionId, 'invalid_totp');
      }
    }

    // Issue session token
    const sessionToken = issueSessionToken(
      config.userId,
      config.google.authorizedSub,
      sessionDays,
      config.sessionSecret,
    );

    const expiresAt = new Date(
      Date.now() + Math.min(Math.max(sessionDays, 1), 30) * 86400 * 1000
    ).toISOString();

    clearTimeout(session.timeoutHandle);
    authSessions.delete(connectionId);

    dc.send(JSON.stringify({
      type: 'auth-ok',
      sessionToken,
      expiresAt,
    }));

    return 'authenticated';
  }

  return 'blocked';
}

/**
 * Clean up auth state for a disconnected DataChannel.
 */
export function cleanupAuth(connectionId: string): void {
  const session = authSessions.get(connectionId);
  if (session) {
    clearTimeout(session.timeoutHandle);
    authSessions.delete(connectionId);
  }
}

/**
 * Check if a connection is authenticated (no longer in auth sessions).
 */
export function isAuthenticated(connectionId: string): boolean {
  return !authSessions.has(connectionId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function authSuccess(
  dc: DataChannelSend,
  connectionId: string,
): 'authenticated' {
  const session = authSessions.get(connectionId);
  if (session) {
    clearTimeout(session.timeoutHandle);
    authSessions.delete(connectionId);
  }
  dc.send(JSON.stringify({ type: 'auth-ok' }));
  return 'authenticated';
}

function sendFailure(
  dc: DataChannelSend,
  connectionId: string,
  reason: string,
): 'pending' {
  const session = authSessions.get(connectionId);
  if (!session) return 'pending';

  session.failCount++;

  if (session.failCount >= MAX_FAILURES) {
    dc.send(JSON.stringify({ type: 'auth-failed', reason: 'rate_limited' }));
    clearTimeout(session.timeoutHandle);
    authSessions.delete(connectionId);
    blockedConnections.set(connectionId, Date.now() + BLOCK_DURATION_MS);
    return 'pending';
  }

  dc.send(JSON.stringify({ type: 'auth-failed', reason }));
  return 'pending';
}
