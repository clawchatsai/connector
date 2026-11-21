import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressReminderState, wantsProgressReminder, registerProgressReminder, PROGRESS_CARD_REMINDER } from './progress-reminder.js';

const allowed = { plugins: { entries: { connector: { hooks: { allowConversationAccess: true } } } } };
const V = '2026.11.6';

test('state: blocked by default, active once conversation access is allowed, off when cards or prompt hooks are off', () => {
  assert.equal(progressReminderState({}, 'connector', V), 'blocked');
  assert.equal(progressReminderState(undefined, 'connector', V), 'blocked');
  assert.equal(progressReminderState(allowed, 'connector', V), 'active');
  assert.equal(progressReminderState({ ...allowed, tools: { updatePlan: false } }, 'connector', V), 'off');
  assert.equal(progressReminderState({ tools: { updatePlan: false } }, 'connector', V), 'off');
  assert.equal(progressReminderState({ plugins: { entries: { connector: { hooks: { allowConversationAccess: true, allowPromptInjection: false } } } } }, 'connector', V), 'off');
  assert.equal(progressReminderState({ plugins: { entries: { connector: { hooks: { allowConversationAccess: false } } } } }, 'connector', V), 'blocked');
});

test('state: unsupported on gateways before 2026.11.6 or of unknown version', () => {
  assert.equal(progressReminderState(allowed, 'connector', '2026.9.7'), 'unsupported');
  assert.equal(progressReminderState(allowed, 'connector', '2026.11.5'), 'unsupported');
  assert.equal(progressReminderState({}, 'connector', '2026.10.30'), 'unsupported');
  assert.equal(progressReminderState(allowed, 'connector', undefined), 'unsupported');
  assert.equal(progressReminderState(allowed, 'connector', 'unknown'), 'unsupported');
  assert.equal(progressReminderState(allowed, 'connector', '2026.11.6-beta.2'), 'active');
  assert.equal(progressReminderState(allowed, 'connector', '2026.12.1'), 'active');
  assert.equal(progressReminderState(allowed, 'connector', '2027.1.0'), 'active');
});

test('reminds only CLI-runtime turns outside the main session and subagents', () => {
  const chat = 'agent:main:clawchats:chat:1b2c';
  assert.equal(wantsProgressReminder({ modelProviderId: 'claude-cli', sessionKey: chat }, {}), true);
  assert.equal(wantsProgressReminder({ modelProviderId: 'codex-cli', sessionKey: chat }, {}), true);
  assert.equal(wantsProgressReminder({ modelProviderId: 'anthropic', sessionKey: chat }, {}), false);
  assert.equal(wantsProgressReminder({ sessionKey: chat }, {}), false);
  assert.equal(wantsProgressReminder({ modelProviderId: 'claude-cli', sessionKey: 'agent:main:main' }, {}), false);
  assert.equal(wantsProgressReminder({ modelProviderId: 'claude-cli', sessionKey: 'agent:main:home' }, { session: { mainKey: 'home' } }), false);
  assert.equal(wantsProgressReminder({ modelProviderId: 'claude-cli', sessionKey: 'agent:main:main' }, { session: { mainKey: 'home' } }), true);
  assert.equal(wantsProgressReminder({ modelProviderId: 'claude-cli', sessionKey: 'agent:main:subagent:9f' }, {}), false);
  assert.equal(wantsProgressReminder({ modelProviderId: 'claude-cli', sessionKey: 'agent:main:clawchats:chat:1:subagent:2' }, {}), false);
  assert.equal(wantsProgressReminder({ modelProviderId: 'claude-cli' }, {}), false);
});

test('registers the hook only when the gateway allows it', () => {
  const calls = [];
  const api = (cfg, version = V) => ({ config: cfg, runtime: { version }, on: (name, fn, opts) => calls.push({ name, fn, opts }) });
  assert.equal(registerProgressReminder(api({}), 'connector'), 'blocked');
  assert.equal(calls.length, 0);
  assert.equal(registerProgressReminder(api({ ...allowed, tools: { updatePlan: false } }), 'connector'), 'off');
  assert.equal(calls.length, 0);
  assert.equal(registerProgressReminder(api(allowed, '2026.9.7'), 'connector'), 'unsupported');
  assert.equal(calls.length, 0);
  // the gateway's CLI-metadata pass: touching api.runtime throws, which must not fail the plugin's register()
  const cliApi = { config: allowed, on: () => calls.push('x'), get runtime() { throw new Error('runtime is intentionally unavailable'); } };
  assert.equal(registerProgressReminder(cliApi, 'connector'), 'unsupported');
  assert.equal(calls.length, 0);
  assert.equal(registerProgressReminder(api(allowed), 'connector'), 'active');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'before_prompt_build');
  assert.deepEqual(calls[0].fn({}, { modelProviderId: 'claude-cli', sessionKey: 'agent:main:clawchats:chat:1' }), { appendSystemContext: PROGRESS_CARD_REMINDER });
  assert.equal(calls[0].fn({}, { modelProviderId: 'anthropic', sessionKey: 'agent:main:clawchats:chat:1' }), undefined);
});
