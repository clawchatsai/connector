/**
 * resolveAuthGate — the DataChannel auth posture decision.
 *
 * The regression this file exists for: a config with `schemaVersion: 2` and a
 * full TOTP block but no `sessionSecret` used to disable auth entirely and
 * hand the browser an unauthenticated DataChannel, with nothing logged. Every
 * incomplete config must block instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';

import {
  resolveAuthGate,
  initAuth,
  handleAuthMessage,
  cleanupAuth,
} from '../../dist/auth-handler.js';
import { issueSessionToken } from '../../dist/session-token.js';

/** A config that satisfies every auth requirement. */
function completeConfig(overrides = {}) {
  return {
    userId: 'user_abc123',
    serverUrl: 'wss://signal.example',
    apiKey: 'k',
    schemaVersion: 2,
    installedAt: '2026-01-01T00:00:00.000Z',
    totp: {
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      enabledAt: '2026-01-01T00:00:00.000Z',
    },
    sessionSecret: 'a'.repeat(64),
    ...overrides,
  };
}

describe('resolveAuthGate', () => {
  it('enables auth for a complete v2 config', () => {
    assert.deepEqual(resolveAuthGate(completeConfig()), { mode: 'enabled' });
  });

  it('enables auth for a complete config on a later schema version', () => {
    // The old check was `schemaVersion === 2`, so a v3 config disabled auth.
    assert.deepEqual(resolveAuthGate(completeConfig({ schemaVersion: 3 })), { mode: 'enabled' });
  });

  it('blocks a v2 config that has TOTP but no session secret', () => {
    const config = completeConfig();
    delete config.sessionSecret;

    assert.deepEqual(resolveAuthGate(config), { mode: 'blocked', missing: ['sessionSecret'] });
  });

  it('blocks a v2 config that has a session secret but no TOTP', () => {
    const config = completeConfig();
    delete config.totp;

    assert.deepEqual(resolveAuthGate(config), { mode: 'blocked', missing: ['totp.secret'] });
  });

  it('blocks a config whose TOTP block carries no secret', () => {
    const config = completeConfig({ totp: { algorithm: 'SHA1', digits: 6, period: 30 } });

    assert.deepEqual(resolveAuthGate(config), { mode: 'blocked', missing: ['totp.secret'] });
  });

  it('blocks a v1 config and names every missing field', () => {
    const config = completeConfig({ schemaVersion: 1 });
    delete config.totp;
    delete config.sessionSecret;

    assert.deepEqual(resolveAuthGate(config), {
      mode: 'blocked',
      missing: ['schemaVersion >= 2', 'totp.secret', 'sessionSecret'],
    });
  });

  it('blocks a config with no schemaVersion at all', () => {
    const config = completeConfig();
    delete config.schemaVersion;

    assert.deepEqual(resolveAuthGate(config), { mode: 'blocked', missing: ['schemaVersion >= 2'] });
  });

  it('blocks when there is no config', () => {
    // loadConfig() returns null for a missing, unreadable or incomplete file.
    assert.deepEqual(resolveAuthGate(null), { mode: 'blocked', missing: ['config'] });
  });
});

/**
 * A gateway paired without Google has no `config.google` — `PluginConfig.google`
 * is optional and `resolveAuthGate` does not require it. But `handleAuthMessage`
 * used to read `config.google.clientId` unconditionally, so every such config
 * was declared `enabled` and then threw `TypeError: Cannot read properties of
 * undefined` on the first real auth attempt. The call site does not catch, so
 * the browser got neither auth-ok nor auth-failed — it hung until the 60s
 * timeout. The ClawChats dev/CI stack writes exactly this config shape.
 */
describe('auth-full without a Google block', () => {
  /** TOTP for `secret` at the current step, as a browser would generate it. */
  function currentTotp(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of secret.replace(/=+$/, '')) {
      bits += alphabet.indexOf(ch.toUpperCase()).toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));

    const counter = Math.floor(Date.now() / 1000 / 30);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
    buf.writeUInt32BE(counter >>> 0, 4);

    const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
  }

  /** Collects everything the connector sends back to the browser. */
  function fakeChannel() {
    const sent = [];
    return { sent, send: (data) => sent.push(JSON.parse(data)) };
  }

  it('authenticates instead of throwing, and issues a session token', async () => {
    const config = completeConfig();
    assert.equal(config.google, undefined, 'fixture must have no Google block');
    assert.deepEqual(resolveAuthGate(config), { mode: 'enabled' });

    const dc = fakeChannel();
    const connectionId = 'conn-no-google';
    initAuth(dc, connectionId);
    const { nonce } = dc.sent.find((m) => m.type === 'auth-required');

    const result = await handleAuthMessage(dc, connectionId, {
      type: 'auth-full',
      idToken: 'signaling-verified',
      totp: currentTotp(config.totp.secret),
      nonce,
    }, config);

    assert.equal(result, 'authenticated');
    const ok = dc.sent.at(-1);
    assert.equal(ok.type, 'auth-ok');
    assert.ok(ok.sessionToken, 'a session token must be issued');

    cleanupAuth(connectionId);
  });

  it('still rejects a wrong TOTP rather than falling open', async () => {
    const config = completeConfig();
    const dc = fakeChannel();
    const connectionId = 'conn-no-google-bad-totp';
    initAuth(dc, connectionId);
    const { nonce } = dc.sent.find((m) => m.type === 'auth-required');

    const result = await handleAuthMessage(dc, connectionId, {
      type: 'auth-full',
      idToken: 'signaling-verified',
      totp: '000000',
      nonce,
    }, config);

    assert.equal(result, 'pending');
    assert.deepEqual(dc.sent.at(-1), { type: 'auth-failed', reason: 'invalid_totp' });

    cleanupAuth(connectionId);
  });

  it('accepts a session token issued for a Google-less config', async () => {
    const config = completeConfig();
    // Minted directly rather than via auth-full: TOTP replay protection is
    // module-global, so a second auth-full in the same 30s step would be
    // rejected for reasons that have nothing to do with what this asserts.
    const sessionToken = issueSessionToken(
      config.userId,
      config.google?.authorizedSub,
      7,
      config.sessionSecret,
    );

    // The resume path reads config.google.authorizedSub too, so it threw as well.
    const second = fakeChannel();
    initAuth(second, 'conn-resume');
    const result = await handleAuthMessage(second, 'conn-resume', {
      type: 'auth-session',
      sessionToken,
    }, config);

    assert.equal(result, 'authenticated');
    assert.equal(second.sent.at(-1).type, 'auth-ok');

    cleanupAuth('conn-resume');
  });
});
