/**
 * config-store.ts — reading and writing ~/.openclaw/clawchats/config.json
 *
 * Every write is atomic (temp file + fsync + rename): the service reads this file on every new
 * browser connection, and a half-written file must never be seen. Writers that change one part
 * of the file (a consumed backup code, a new TOTP secret) re-read it from disk and change only
 * that part, so nobody writes back a stale copy (e.g. undoing a `reauth`).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from './plugin-config.js';
import type { AuthConfig } from './auth-handler.js';

/**
 * Write a file so readers see either the old or the new content, never a partial one.
 * `beforeRename` returning false abandons the write (returns false).
 */
export function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600, beforeRename?: () => boolean): boolean {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (beforeRename && !beforeRename()) {
      fs.unlinkSync(tmp);
      return false;
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
  // Make the rename itself durable. Not supported everywhere (Windows): best effort.
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* best effort */ }
  return true;
}

const readRaw = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

function parseConfig(raw: string | null): PluginConfig | null {
  try {
    const cfg = JSON.parse(raw ?? '') as PluginConfig;
    if (!cfg || typeof cfg !== 'object' || !cfg.userId || !cfg.apiKey || !cfg.serverUrl) return null;
    return cfg;
  } catch {
    return null;
  }
}

/** The config, or null when it is missing, unparseable or lacks the signaling credentials. */
export function readConfig(file: string): PluginConfig | null {
  return parseConfig(readRaw(file));
}

export function writeConfig(file: string, config: PluginConfig): void {
  writeFileAtomic(file, JSON.stringify(config, null, 2));
}

/**
 * Read-modify-write: re-reads the config from disk, applies `mutate`, writes it atomically.
 * If another process (CLI or service) changed the file meanwhile, starts over from its version
 * instead of overwriting it. `mutate` may run more than once; returning false means "nothing to
 * change" (no write). Returns null (no write) when there is no valid config on disk.
 */
export function updateConfig(file: string, mutate: (cfg: PluginConfig) => boolean | void): PluginConfig | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = readRaw(file);
    const cfg = parseConfig(raw);
    if (!cfg) return null;
    if (mutate(cfg) === false) return cfg;
    if (writeFileAtomic(file, JSON.stringify(cfg, null, 2), 0o600, () => readRaw(file) === raw)) return cfg;
  }
  throw new Error(`${file} keeps changing; try again`);
}

/** Consume a backup code: remove its hash from the config on disk. False if it wasn't there. */
export function removeBackupCode(file: string, hash: string): boolean {
  let removed = false;
  updateConfig(file, (cfg) => {
    const i = Array.isArray(cfg.backupCodeHashes) ? cfg.backupCodeHashes.indexOf(hash) : -1;
    if (i < 0) return false;
    cfg.backupCodeHashes!.splice(i, 1);
    removed = true;
  });
  return removed;
}

export type AuthConfigResult =
  | { ok: true; config: AuthConfig }
  /** missing: no usable config; needs-2fa: valid config without TOTP set up; invalid: TOTP fields malformed */
  | { ok: false; reason: 'missing' | 'needs-2fa' | 'invalid' };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * The browser login settings, freshly read from disk. Only a complete schemaVersion 2 config
 * with TOTP and a session secret allows logins; anything else refuses every browser.
 */
export function readAuthConfig(file: string, devMode = false): AuthConfigResult {
  const cfg = readConfig(file);
  if (!cfg) return { ok: false, reason: fs.existsSync(file) ? 'invalid' : 'missing' };
  if (!cfg.totp && !cfg.sessionSecret && (cfg.schemaVersion === undefined || cfg.schemaVersion < 2)) {
    return { ok: false, reason: 'needs-2fa' };
  }
  const t = cfg.totp;
  const g = cfg.google;
  if (cfg.schemaVersion !== 2 || !isStr(cfg.userId)
    || !t || typeof t !== 'object' || !isStr(t.secret)
    || !isStr(cfg.sessionSecret) || !/^[0-9a-f]{64}$/i.test(cfg.sessionSecret)
    || (cfg.backupCodeHashes !== undefined && (!Array.isArray(cfg.backupCodeHashes) || !cfg.backupCodeHashes.every(isStr)))
    || (g !== undefined && (!g || typeof g !== 'object' || typeof g.clientId !== 'string'
      || typeof g.authorizedSub !== 'string' || typeof g.authorizedEmail !== 'string'))) {
    return { ok: false, reason: 'invalid' };
  }
  return {
    ok: true,
    config: {
      userId: cfg.userId,
      totp: t,
      // No Google identity bound (dev installs): placeholder, Google check skipped
      google: g ?? { clientId: 'dev-placeholder', authorizedSub: 'dev-placeholder', authorizedEmail: 'dev@localhost' },
      sessionSecret: cfg.sessionSecret,
      backupCodeHashes: cfg.backupCodeHashes,
      devMode,
    },
  };
}

/**
 * Identifies the login secrets a browser authenticated under. It changes on `reauth` (new TOTP
 * secret and session secret) and authenticated connections from before are then closed.
 */
export function authEpoch(config: AuthConfig): string {
  return crypto.createHash('sha256').update(`${config.sessionSecret}\n${config.totp.secret}`).digest('hex').slice(0, 32);
}
