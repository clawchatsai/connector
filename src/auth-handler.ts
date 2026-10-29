/**
 * auth-handler.ts — DataChannel authentication gate
 *
 * Every browser DataChannel goes through attachBrowserChannel() before anything else sees it:
 * 1. Refuse (message + close) unless the config on disk is complete with TOTP set up
 * 2. Send auth-required with nonce
 * 3. Wait for auth-session (cached JWT) or auth-full (Google + TOTP), validating every field
 * 4. Verify against the config as it is on disk at that moment
 * 5. Issue session token on success; only then are messages handed to the request handlers
 * A channel that does not log in within 60 s, fails too often or sends malformed login
 * messages is closed. Login failures and lockouts survive a restart (auth-state.json).
 *
 * Spec: datachannel-auth-totp.md §4
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { verifyTotp, verifyBackupCode } from './totp.js';
import { verifyGoogleIdToken, clearJWKSCache } from './google-jwt.js';
import { issueSessionToken, verifySessionToken } from './session-token.js';
import { authEpoch, writeFileAtomic, type AuthConfigResult } from './config-store.js';

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

/** The DataChannel surface the gate needs (webrtc-peer.ts DataChannelLike). */
export interface AuthChannel {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClosed(handler: () => void): void;
}

export interface BrowserChannelHooks {
  /** Fresh read of the login settings from disk. Called on open and again at every verification. */
  loadAuthConfig: () => AuthConfigResult;
  /** Remove one backup code (by hash) from the config on disk; false if it is no longer there. */
  consumeBackupCode: (hash: string) => boolean;
  /** The channel logged in. */
  onAuthenticated: () => void;
  /** A message on a logged-in channel. Errors (thrown or rejected) are logged, never propagated. */
  onMessage: (msg: Record<string, unknown>) => void | Promise<void>;
  /** A wrong TOTP / backup code was tried (for telling already logged-in browsers). */
  onLoginFailure?: (reason: string) => void;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

interface ChannelState {
  connectionId: string;
  dc: AuthChannel;
  status: 'pending' | 'authenticated' | 'closed';
  nonce: string;
  failCount: number;
  timer?: ReturnType<typeof setTimeout>;
  /** authEpoch() of the config this channel logged in under. */
  epoch?: string;
  /** Pre-auth messages are handled one at a time, in order. */
  chain: Promise<void>;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Channels waiting to log in, gateway-wide. Further ones are refused until some finish. */
export const MAX_PENDING_CHANNELS = 10;
/** A channel that has not logged in by then is closed. */
export const AUTH_TIMEOUT_MS = 60_000; // enough time to open authenticator app and enter code
const MAX_FAILURES = 5; // per channel, then it is closed
const MAX_PREAUTH_MESSAGE_LENGTH = 16 * 1024;
const MAX_TOKEN_LENGTH = 8 * 1024; // Google ID tokens and session JWTs are ~1-2 KB
const MAX_CODE_LENGTH = 64;
const GLOBAL_MAX_FAILURES = 5;
const GLOBAL_LOCKOUT_BASE_MS = 60_000; // doubles per consecutive lockout
const GLOBAL_LOCKOUT_MAX_MS = 60 * 60_000;

const SETUP_MESSAGES: Record<'missing' | 'needs-2fa' | 'invalid', string> = {
  'needs-2fa': 'Two-factor authentication is required. Run "openclaw clawchats reauth" on your gateway machine to set it up.',
  invalid: 'The ClawChats login settings on your gateway are incomplete or damaged. Run "openclaw clawchats reauth" on your gateway machine.',
  missing: 'ClawChats is not set up on your gateway. Run "openclaw clawchats setup <token>" on your gateway machine.',
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const channels = new Set<ChannelState>();

/**
 * Gateway-wide TOTP lockout and replay guard. Per-channel limits alone reset on every
 * reconnect, so failures are also counted across all channels, and kept across restarts.
 */
interface PersistedAuthState {
  failCount: number;
  lockoutCount: number;
  lockedUntil: number;
  lastUsedTotpStep: number;
}
const freshState = (): PersistedAuthState => ({ failCount: 0, lockoutCount: 0, lockedUntil: 0, lastUsedTotpStep: 0 });
let authState = freshState();
let authStateFile: string | null = null;

/** Load the persisted lockout state (call once at service start). Unreadable = fresh state. */
export function loadAuthState(file: string): void {
  authStateFile = file;
  authState = freshState();
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!raw || typeof raw !== 'object') return;
  for (const k of Object.keys(authState) as Array<keyof PersistedAuthState>) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) authState[k] = v;
  }
}

function saveAuthState(): void {
  if (!authStateFile) return;
  try { writeFileAtomic(authStateFile, JSON.stringify(authState)); }
  catch (e) { console.error(`[Auth] could not save login lockout state: ${(e as Error).message}`); }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Put a new browser DataChannel behind the login gate. Nothing reaches hooks.onMessage
 * before the channel has logged in.
 */
export function attachBrowserChannel(dc: AuthChannel, connectionId: string, hooks: BrowserChannelHooks): void {
  const ch: ChannelState = { connectionId, dc, status: 'pending', nonce: '', failCount: 0, chain: Promise.resolve() };
  dc.onClosed(() => detach(ch));

  const cfg = hooks.loadAuthConfig();
  if (!cfg.ok) {
    refuseSetup(ch, cfg.reason, hooks);
    return;
  }
  if (pendingCount() >= MAX_PENDING_CHANNELS) {
    hooks.log.warn(`Browser ${connectionId} refused: ${MAX_PENDING_CHANNELS} connections are already waiting to log in`);
    refuse(ch, { type: 'auth-failed', reason: 'rate_limited' });
    return;
  }

  channels.add(ch);
  ch.nonce = crypto.randomBytes(32).toString('hex');
  ch.timer = setTimeout(() => {
    if (ch.status === 'pending') refuse(ch, { type: 'auth-failed', reason: 'auth_timeout' });
  }, AUTH_TIMEOUT_MS);
  ch.timer.unref?.();
  dc.onMessage((data: string) => onData(ch, data, hooks));
  dc.send(JSON.stringify({ type: 'auth-required', nonce: ch.nonce }));
}

/**
 * The config on disk changed: close logged-in channels whose login secrets are gone
 * (`reauth`, `reset`, a deleted or broken config). Returns their connection ids.
 */
export function revokeStaleChannels(current: AuthConfigResult): string[] {
  const epoch = current.ok ? authEpoch(current.config) : null;
  const revoked: string[] = [];
  for (const ch of [...channels]) {
    if (ch.status === 'authenticated' && ch.epoch !== epoch) {
      // invalid_session: the browser forgets its session token and asks for a new login
      refuse(ch, { type: 'auth-failed', reason: 'invalid_session' });
      revoked.push(ch.connectionId);
    }
  }
  return revoked;
}

/** Tests only: forget every channel and the lockout state. */
export function _resetAuthForTests(): void {
  for (const ch of channels) if (ch.timer) clearTimeout(ch.timer);
  channels.clear();
  authState = freshState();
  authStateFile = null;
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function onData(ch: ChannelState, data: string, hooks: BrowserChannelHooks): void {
  if (ch.status === 'closed') return;
  if (ch.status === 'authenticated') { void handleAuthenticated(ch, data, hooks); return; }
  ch.chain = ch.chain
    .then(() => handlePreAuth(ch, data, hooks))
    .catch((e: unknown) => {
      hooks.log.error(`Login handling failed for ${ch.connectionId}: ${(e as Error)?.stack || e}`);
      refuse(ch, { type: 'auth-failed', reason: 'internal_error' });
    });
}

async function handleAuthenticated(ch: ChannelState, data: string, hooks: BrowserChannelHooks): Promise<void> {
  try {
    let msg: unknown;
    try { msg = JSON.parse(data); } catch { msg = undefined; }
    if (!isObject(msg)) {
      ch.dc.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }
    await hooks.onMessage(msg);
  } catch (e) {
    hooks.log.error(`Message handling failed on ${ch.connectionId}: ${(e as Error)?.stack || e}`);
  }
}

async function handlePreAuth(ch: ChannelState, data: string, hooks: BrowserChannelHooks): Promise<void> {
  if (ch.status === 'authenticated') return handleAuthenticated(ch, data, hooks); // queued behind the login
  if (ch.status !== 'pending') return;

  let msg: unknown;
  if (typeof data === 'string' && data.length <= MAX_PREAUTH_MESSAGE_LENGTH) {
    try { msg = JSON.parse(data); } catch { msg = undefined; }
  }
  if (!isObject(msg)) return refuseMalformed(ch, hooks, 'not a JSON object or too large');

  if (msg['type'] === 'auth-session') return authSession(ch, msg, hooks);
  if (msg['type'] === 'auth-full') return authFull(ch, msg, hooks);
  // Anything else before login is dropped: it never reaches a request handler.
}

async function authSession(ch: ChannelState, msg: Record<string, unknown>, hooks: BrowserChannelHooks): Promise<void> {
  const token = msg['sessionToken'];
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) {
    return refuseMalformed(ch, hooks, 'bad sessionToken');
  }
  const cfg = hooks.loadAuthConfig();
  if (!cfg.ok) return refuseSetup(ch, cfg.reason, hooks);
  const config = cfg.config;
  try {
    verifySessionToken(token, config.sessionSecret, config.userId, config.google.authorizedSub);
  } catch (e) {
    // On expired session, don't count as failure — just prompt for full auth
    if ((e as Error).message === 'expired_session') {
      ch.dc.send(JSON.stringify({ type: 'auth-failed', reason: 'expired_session' }));
      return;
    }
    return failure(ch, 'invalid_session');
  }
  succeed(ch, config, hooks, { type: 'auth-ok' });
}

async function authFull(ch: ChannelState, msg: Record<string, unknown>, hooks: BrowserChannelHooks): Promise<void> {
  const { idToken, totp, nonce } = msg;
  if (typeof idToken !== 'string' || idToken.length > MAX_TOKEN_LENGTH
    || typeof totp !== 'string' || totp.length > MAX_CODE_LENGTH
    || typeof nonce !== 'string') {
    return refuseMalformed(ch, hooks, 'bad auth-full fields');
  }
  const sessionDays = typeof msg['sessionDays'] === 'number' && Number.isFinite(msg['sessionDays']) ? msg['sessionDays'] : 7;

  // Gateway-wide lockout: refuse without checking anything, so no guess is tested
  if (Date.now() < authState.lockedUntil) {
    ch.dc.send(JSON.stringify({ type: 'auth-failed', reason: 'rate_limited' }));
    return;
  }

  if (nonce !== ch.nonce) return failure(ch, 'nonce_mismatch');

  const before = hooks.loadAuthConfig();
  if (!before.ok) return refuseSetup(ch, before.reason, hooks);
  const google = before.config.google;

  // Google ID token check. The frontend sends 'signaling-verified' on purpose
  // (bd29058): login.clawchats.ai already did Google sign-in, so TOTP is the
  // connector-side factor and the gateway-wide lockout above protects it.
  const skipGoogle = !google.clientId || google.clientId === 'dev-placeholder'
    || idToken === 'signaling-verified'
    || (before.config.devMode && idToken === 'dev-mode-no-google');
  if (skipGoogle) {
    console.log('[Auth] Skipping Google ID token verification (TOTP-only auth)');
  } else {
    const opts = { clientId: google.clientId, authorizedSub: google.authorizedSub, authorizedEmail: google.authorizedEmail };
    try {
      await verifyGoogleIdToken(idToken, opts);
    } catch (e) {
      console.error(`[Auth] Google ID token verification failed: ${(e as Error).message}`);
      // Retry with fresh JWKS on first failure (key rotation)
      clearJWKSCache();
      try {
        await verifyGoogleIdToken(idToken, opts);
      } catch {
        return failure(ch, 'invalid_id_token');
      }
    }
  }
  if (ch.status !== 'pending') return; // closed or timed out while Google was checked

  // Verify against the config on disk now, not the one read before the wait above:
  // a `reauth` in between must not let the old secrets through.
  const cfg = hooks.loadAuthConfig();
  if (!cfg.ok) return refuseSetup(ch, cfg.reason, hooks);
  const config = cfg.config;
  if (Date.now() < authState.lockedUntil) { // another channel triggered the lockout meanwhile
    ch.dc.send(JSON.stringify({ type: 'auth-failed', reason: 'rate_limited' }));
    return;
  }

  // Verify TOTP or backup code
  const totpStep = verifyTotp(totp, config.totp.secret, authState.lastUsedTotpStep);
  if (totpStep >= 0) {
    authState.lastUsedTotpStep = totpStep;
  } else {
    const backupIndex = config.backupCodeHashes ? verifyBackupCode(totp, config.backupCodeHashes) : -1;
    // A backup code is one-time: it counts only if it was still on disk and is now removed.
    if (backupIndex < 0 || !hooks.consumeBackupCode(config.backupCodeHashes![backupIndex])) {
      recordGlobalFailure();
      hooks.onLoginFailure?.('invalid_totp');
      return failure(ch, 'invalid_totp');
    }
  }
  authState.failCount = 0;
  authState.lockoutCount = 0;
  saveAuthState();

  const sessionToken = issueSessionToken(config.userId, config.google.authorizedSub, sessionDays, config.sessionSecret);
  const expiresAt = new Date(
    Date.now() + Math.min(Math.max(sessionDays, 1), 30) * 86400 * 1000,
  ).toISOString();
  succeed(ch, config, hooks, { type: 'auth-ok', sessionToken, expiresAt });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function pendingCount(): number {
  let n = 0;
  for (const ch of channels) if (ch.status === 'pending') n++;
  return n;
}

function succeed(ch: ChannelState, config: AuthConfig, hooks: BrowserChannelHooks, ok: Record<string, unknown>): void {
  if (ch.timer) clearTimeout(ch.timer);
  ch.status = 'authenticated';
  ch.epoch = authEpoch(config);
  ch.dc.send(JSON.stringify(ok));
  hooks.onAuthenticated();
}

/** Wrong credentials: tell the browser; too many on one channel closes it. */
function failure(ch: ChannelState, reason: string): void {
  ch.failCount++;
  if (ch.failCount >= MAX_FAILURES) return refuse(ch, { type: 'auth-failed', reason: 'rate_limited' });
  ch.dc.send(JSON.stringify({ type: 'auth-failed', reason }));
}

function refuseSetup(ch: ChannelState, reason: 'missing' | 'needs-2fa' | 'invalid', hooks: BrowserChannelHooks): void {
  hooks.log.warn(`Browser ${ch.connectionId} refused: ${reason === 'needs-2fa' ? 'TOTP not set up' : `ClawChats config ${reason}`}. Run: openclaw clawchats reauth`);
  refuse(ch, { type: 'auth-required-setup', message: SETUP_MESSAGES[reason] });
}

function refuseMalformed(ch: ChannelState, hooks: BrowserChannelHooks, why: string): void {
  hooks.log.warn(`Browser ${ch.connectionId} closed: malformed login message (${why})`);
  refuse(ch, { type: 'auth-failed', reason: 'invalid_request' });
}

/** Send a last message and close the channel. No further message on it is handled. */
function refuse(ch: ChannelState, last: Record<string, unknown>): void {
  if (ch.status === 'closed') return;
  detach(ch);
  try { ch.dc.send(JSON.stringify(last)); } catch { /* already gone */ }
  try { ch.dc.close(); } catch { /* already gone */ }
}

function detach(ch: ChannelState): void {
  ch.status = 'closed';
  if (ch.timer) clearTimeout(ch.timer);
  channels.delete(ch);
}

function recordGlobalFailure(): void {
  authState.failCount++;
  if (authState.failCount >= GLOBAL_MAX_FAILURES) {
    const duration = Math.min(GLOBAL_LOCKOUT_BASE_MS * 2 ** authState.lockoutCount, GLOBAL_LOCKOUT_MAX_MS);
    authState.lockedUntil = Date.now() + duration;
    authState.lockoutCount++;
    authState.failCount = 0;
    console.warn(`[Auth] ${GLOBAL_MAX_FAILURES} failed TOTP attempts — full auth locked for ${duration / 1000}s`);
  }
  saveAuthState();
}
