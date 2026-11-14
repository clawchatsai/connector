/**
 * auth-handler.ts — DataChannel authentication gate (device keys, authVersion 2)
 *
 * Every browser DataChannel goes through attachBrowserChannel() before anything else sees it:
 * 1. Refuse (message + close) unless the config on disk is complete with TOTP set up
 * 2. Send auth-required: a random nonce, this connector's public key, and its signature over the
 *    channel (nonce, connection id, both DTLS fingerprints). The browser checks that first, so
 *    it never sends anything to a relay that terminated DTLS on its own.
 * 3. Wait for auth-device (a paired browser signing the same channel data with its device key)
 *    or auth-pair (a new browser: its public key, proven with a TOTP/backup code that is bound
 *    to the channel and never sent), validating every field
 * 4. Verify against the config as it is on disk at that moment
 * 5. Only then are messages handed to the request handlers
 * There is no bearer token: nothing a browser sends can be replayed on another channel.
 * A channel that does not log in within 60 s, fails too often or sends malformed login
 * messages is closed. Failed pairings and failed device signatures count towards a lockout that
 * survives a restart (auth-state.json).
 *
 * Spec: specs/device-keys-auth.md (clawchats repo)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { totpCandidates } from './totp.js';
import { writeFileAtomic, MAX_DEVICES, type AuthConfigResult } from './config-store.js';
import type { PairedDevice } from './plugin-config.js';
import {
  AUTH_VERSION, transcript, deviceIdOf, verifyEd25519, isEd25519Spki, pairProof, proofEquals, type ChannelBinding,
} from './channel-binding.js';

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
  backupCodeHashes?: string[];
  /** Paired browsers. */
  devices: PairedDevice[];
}

/** The DataChannel surface the gate needs (webrtc-peer.ts DataChannelLike). */
export interface AuthChannel {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClosed(handler: () => void): void;
}

/** DTLS fingerprints of the two certificates on this connection, from the SDPs (64 hex digits each). */
export interface DtlsFingerprints {
  browser: string;
  connector: string;
}

export interface BrowserChannelHooks {
  /** Fresh read of the login settings from disk. Called on open and again at every verification. */
  loadAuthConfig: () => AuthConfigResult;
  /** Remove one backup code (by hash) from the config on disk; false if it is no longer there. */
  consumeBackupCode: (hash: string) => boolean;
  /** This connector's identity (server/peer/keys.js): the public key (SPKI base64) and Ed25519 signing. */
  connectorKey: { publicKey: string; sign: (data: string) => string };
  /** Save a newly paired device in the config on disk, if its TOTP secret is still `totpSecret` (the one the code was checked against). */
  addDevice: (device: PairedDevice, totpSecret: string) => 'ok' | 'full' | 'gone' | 'stale';
  /** A paired device logged in (updates its lastSeen; failures are not the login's problem). */
  touchDevice: (deviceId: string) => void;
  /** The channel logged in. `paired`: this login added the device. */
  onAuthenticated: (info: { deviceId: string; label: string; paired: boolean }) => void;
  /** A message on a logged-in channel. Errors (thrown or rejected) are logged, never propagated. */
  onMessage: (msg: Record<string, unknown>) => void | Promise<void>;
  /** A wrong code or signature was tried (for telling already logged-in browsers). */
  onLoginFailure?: (reason: string) => void;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

interface ChannelState {
  connectionId: string;
  dc: AuthChannel;
  status: 'pending' | 'authenticated' | 'closed';
  binding: ChannelBinding | null;
  failCount: number;
  timer?: ReturnType<typeof setTimeout>;
  /** The device this channel logged in as. */
  device?: { deviceId: string; pubkey: string };
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
const MAX_SIG_LENGTH = 200; // Ed25519 signatures are 88 base64 characters
const MAX_LABEL_LENGTH = 64;
const GLOBAL_MAX_FAILURES = 5;
const GLOBAL_LOCKOUT_BASE_MS = 60_000; // doubles per consecutive lockout
const GLOBAL_LOCKOUT_MAX_MS = 60 * 60_000;

const SETUP_MESSAGES: Record<'missing' | 'needs-2fa' | 'invalid', string> = {
  'needs-2fa': 'Two-factor authentication is required. Run "openclaw clawchats reauth" on your gateway machine to set it up.',
  invalid: 'The ClawChats login settings on your gateway are incomplete or damaged. Run "openclaw clawchats reauth" on your gateway machine.',
  missing: 'ClawChats is not set up on your gateway. Run "openclaw clawchats setup <token>" on your gateway machine.',
};

/**
 * What a browser that still has the old login (session tokens, authVersion 1) is told. It shows
 * a gateway's `auth-required-setup` text as is; its "reconnect" button reloads the page, which
 * fetches the new frontend. (Other `auth-failed` reasons it does not know are silently ignored.)
 */
const OLD_FRONTEND_MESSAGE = 'This connector was updated and your browser still has the old ClawChats app. Reload the page (Ctrl+Shift+R) to get the new version, then pair this browser with a code from your authenticator app.';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const channels = new Set<ChannelState>();

/**
 * Gateway-wide code lockout and replay guard. Per-channel limits alone reset on every
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
 * @param dtls both certificates' fingerprints as this side sees them in the SDPs; without both
 *             the channel cannot be bound and is refused.
 */
export function attachBrowserChannel(dc: AuthChannel, connectionId: string, hooks: BrowserChannelHooks, dtls?: DtlsFingerprints): void {
  const ch: ChannelState = { connectionId, dc, status: 'pending', binding: null, failCount: 0, chain: Promise.resolve() };
  dc.onClosed(() => detach(ch));

  const cfg = hooks.loadAuthConfig();
  if (!cfg.ok) {
    refuseSetup(ch, cfg.reason, hooks);
    return;
  }
  if (!dtls?.browser || !dtls.connector) {
    hooks.log.warn(`Browser ${connectionId} refused: could not read the DTLS fingerprints from the SDP`);
    refuse(ch, { type: 'auth-failed', reason: 'no_channel_binding' });
    return;
  }
  if (pendingCount() >= MAX_PENDING_CHANNELS) {
    hooks.log.warn(`Browser ${connectionId} refused: ${MAX_PENDING_CHANNELS} connections are already waiting to log in`);
    refuse(ch, { type: 'auth-failed', reason: 'rate_limited' });
    return;
  }

  channels.add(ch);
  const { publicKey, sign } = hooks.connectorKey;
  ch.binding = {
    nonce: crypto.randomBytes(32).toString('hex'),
    connectionId,
    browserFp: dtls.browser,
    connectorFp: dtls.connector,
    connectorPub: publicKey,
  };
  ch.timer = setTimeout(() => {
    if (ch.status === 'pending') refuse(ch, { type: 'auth-failed', reason: 'auth_timeout' });
  }, AUTH_TIMEOUT_MS);
  ch.timer.unref?.();
  dc.onMessage((data: string) => onData(ch, data, hooks));
  dc.send(JSON.stringify({
    type: 'auth-required',
    authVersion: AUTH_VERSION,
    nonce: ch.binding.nonce,
    connectorKey: publicKey,
    connectorSig: sign(transcript('connector', ch.binding)),
  }));
}

/**
 * The config on disk changed: close logged-in channels whose device is no longer paired
 * (`devices revoke`, `reauth`, `reset`, a deleted or broken config). Returns their connection ids.
 */
export function revokeStaleChannels(current: AuthConfigResult): string[] {
  const revoked: string[] = [];
  for (const ch of [...channels]) {
    if (ch.status !== 'authenticated') continue;
    const still = current.ok && current.config.devices.some(d => d.deviceId === ch.device?.deviceId && d.pubkey === ch.device?.pubkey);
    if (!still) {
      // device_revoked: the browser asks for a new pairing
      refuse(ch, { type: 'auth-failed', reason: 'device_revoked' });
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

  if (msg['type'] === 'auth-device') return authDevice(ch, msg, hooks);
  if (msg['type'] === 'auth-pair') return authPair(ch, msg, hooks);
  if (msg['type'] === 'auth-session' || msg['type'] === 'auth-full') {
    // The old login. Never honoured, whatever it carries.
    hooks.log.warn(`Browser ${ch.connectionId} refused: it uses the old login (session token); it needs the new ClawChats app`);
    return refuse(ch, { type: 'auth-required-setup', message: OLD_FRONTEND_MESSAGE });
  }
  // Anything else before login is dropped: it never reaches a request handler.
}

/** A paired browser: its signature over this channel, made with the device key. */
function authDevice(ch: ChannelState, msg: Record<string, unknown>, hooks: BrowserChannelHooks): void {
  const { deviceId, sig } = msg;
  if (typeof deviceId !== 'string' || !/^[0-9a-f]{32}$/.test(deviceId) || typeof sig !== 'string' || sig.length > MAX_SIG_LENGTH) {
    return refuseMalformed(ch, hooks, 'bad auth-device fields');
  }
  const cfg = hooks.loadAuthConfig();
  if (!cfg.ok) return refuseSetup(ch, cfg.reason, hooks);
  const device = cfg.config.devices.find(d => d.deviceId === deviceId);
  if (!device) return failure(ch, 'unknown_device'); // revoked, or never paired: the browser offers pairing
  if (!verifyEd25519(device.pubkey, transcript('device', ch.binding!, device.pubkey), sig)) {
    recordGlobalFailure();
    hooks.onLoginFailure?.('invalid_signature');
    return failure(ch, 'invalid_signature');
  }
  hooks.touchDevice(device.deviceId);
  succeed(ch, device, false, hooks);
}

/** A new browser: its public key, signed, with a proof of the one-time code that is tied to this channel. */
function authPair(ch: ChannelState, msg: Record<string, unknown>, hooks: BrowserChannelHooks): void {
  const { devicePub, label, kind, proof, sig } = msg;
  if (!isEd25519Spki(devicePub)
    || typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL_LENGTH
    || (kind !== 'totp' && kind !== 'backup')
    || typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)
    || typeof sig !== 'string' || sig.length > MAX_SIG_LENGTH) {
    return refuseMalformed(ch, hooks, 'bad auth-pair fields');
  }

  // Gateway-wide lockout: refuse without checking anything, so no guess is tested
  if (Date.now() < authState.lockedUntil) {
    ch.dc.send(JSON.stringify({ type: 'auth-failed', reason: 'rate_limited' }));
    return;
  }

  const cfg = hooks.loadAuthConfig();
  if (!cfg.ok) return refuseSetup(ch, cfg.reason, hooks);
  const config = cfg.config;
  const deviceId = deviceIdOf(devicePub);
  if (config.devices.length >= MAX_DEVICES && !config.devices.some(d => d.deviceId === deviceId)) {
    return failure(ch, 'too_many_devices');
  }

  // The signature proves the sender holds the private half of devicePub and that label and key
  // were not swapped in transit; the proof below ties the code to this channel and this key.
  const signed = transcript('pair', ch.binding!, devicePub, label);
  if (!verifyEd25519(devicePub, signed, sig)) {
    recordGlobalFailure();
    hooks.onLoginFailure?.('invalid_signature');
    return failure(ch, 'invalid_signature');
  }

  let step = -1;
  let backupHash: string | null = null;
  if (kind === 'totp') {
    for (const cand of totpCandidates(config.totp.secret, authState.lastUsedTotpStep)) {
      if (proofEquals(pairProof(cand.code, signed), proof)) { step = cand.step; break; }
    }
  } else {
    for (const hash of config.backupCodeHashes ?? []) {
      if (proofEquals(pairProof(hash, signed), proof)) { backupHash = hash; break; }
    }
  }
  if (step >= 0) {
    authState.lastUsedTotpStep = step;
  } else if (!backupHash || !hooks.consumeBackupCode(backupHash)) {
    // A backup code is one-time: it counts only if it was still on disk and is now removed.
    recordGlobalFailure();
    hooks.onLoginFailure?.('invalid_code');
    return failure(ch, 'invalid_code');
  }
  authState.failCount = 0;
  authState.lockoutCount = 0;
  saveAuthState();

  const now = new Date().toISOString();
  const device: PairedDevice = { deviceId, pubkey: devicePub, label: label.trim(), createdAt: now, lastSeen: now };
  const added = hooks.addDevice(device, config.totp.secret);
  if (added === 'gone') return refuseSetup(ch, 'missing', hooks);
  if (added === 'full') return failure(ch, 'too_many_devices');
  if (added === 'stale') return failure(ch, 'invalid_code'); // `reauth` ran while the code was being checked
  succeed(ch, device, true, hooks);
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

function succeed(ch: ChannelState, device: PairedDevice, paired: boolean, hooks: BrowserChannelHooks): void {
  if (ch.timer) clearTimeout(ch.timer);
  ch.status = 'authenticated';
  ch.device = { deviceId: device.deviceId, pubkey: device.pubkey };
  ch.dc.send(JSON.stringify({ type: 'auth-ok', deviceId: device.deviceId, label: device.label, paired }));
  hooks.onAuthenticated({ deviceId: device.deviceId, label: device.label, paired });
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
    console.warn(`[Auth] ${GLOBAL_MAX_FAILURES} failed login attempts — pairing locked for ${duration / 1000}s`);
  }
  saveAuthState();
}
