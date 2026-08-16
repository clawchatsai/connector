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

import { resolveAuthGate } from '../../dist/auth-handler.js';

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
