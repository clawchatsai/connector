import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTag, normalizeTags, condense, buildPrompt, parseReply, effectiveTags, estimateCost, tagsModelFromConfig } from './model.js';

test('normalizeTag: one lowercase hyphenated token; noise and junk dropped', () => {
  assert.equal(normalizeTag('#Laser Show'), 'laser-show');
  assert.equal(normalizeTag('home_lab'), 'home-lab');
  assert.equal(normalizeTag('  CI / CD '), 'ci-cd');
  assert.equal(normalizeTag('node.js'), 'node.js');
  assert.equal(normalizeTag('C++'), 'c++');
  assert.equal(normalizeTag('chat'), '');
  assert.equal(normalizeTag('2026'), '');
  assert.equal(normalizeTag('a very long tag with words'), '');
  assert.equal(normalizeTag('x'.repeat(40)), '');
  assert.equal(normalizeTag(null), '');
});

test('normalizeTag: folds onto the vocabulary (plurals) and follows aliases', () => {
  const vocabulary = new Set(['deploy', 'backups']);
  assert.equal(normalizeTag('deploys', { vocabulary }), 'deploy');
  assert.equal(normalizeTag('backup', { vocabulary }), 'backups');
  assert.equal(normalizeTag('kubernetes', { vocabulary }), 'kubernetes');
  const aliases = new Map([['proxmox-ve', 'proxmox'], ['junk', '']]);
  assert.equal(normalizeTag('Proxmox VE', { aliases }), 'proxmox');
  assert.equal(normalizeTag('junk', { aliases }), '');
  assert.equal(normalizeTag('a', { aliases: new Map([['aa', 'bb'], ['bb', 'aa']]) }), 'a');
  assert.equal(normalizeTag('aa', { aliases: new Map([['aa', 'bb'], ['bb', 'aa']]) }).length, 2); // cycle: bounded
});

test('normalizeTags: distinct, capped', () => {
  assert.deepEqual(normalizeTags(['A', 'a', '#a', 'b', 'chat', 'c', 'd', 'e', 'f']), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(normalizeTags('nope'), []);
});

test('condense: the start and the latest messages within budget, a gap marker between', () => {
  const msgs = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', kind: 'message', text: `message ${i} ${'x'.repeat(200)}` }));
  const out = condense(msgs, 3000);
  assert.ok(out.length <= 3000);
  assert.match(out, /^User: message 0 /);
  assert.match(out, /AI: message 49 x+$/);
  assert.match(out, /\[… \d+ messages left out …\]/);
  assert.doesNotMatch(out, /message 10 /);
  const comment = condense([{ role: 'user', kind: 'comment', text: 'check this', quote: 'the quoted bit' }]);
  assert.equal(comment, 'User comment (on "the quoted bit"): check this');
  assert.equal(condense([{ role: 'user', kind: 'message', text: 'a'.repeat(5000) }]).length, 'User: '.length + 600);
});

test('buildPrompt: vocabulary first when there is one', () => {
  assert.match(buildPrompt({ title: 'T', conversation: 'User: hi', vocabulary: ['proxmox', 'laser-show'] }), /^Tags already in use .*: proxmox, laser-show\n/);
  assert.match(buildPrompt({ title: '', conversation: 'User: hi' }), /^Chat title: \(none\)/);
});

test('parseReply: fenced or bare JSON, normalized; garbage throws', () => {
  const r = parseReply('Sure!\n```json\n{"summary":"Fixed  the\\nbackup job.","tags":["Proxmox","Backups","chat"],"keywords":["vm 104","vm 104","pbs"]}\n```');
  assert.deepEqual(r, { summary: 'Fixed the backup job.', tags: ['proxmox', 'backups'], keywords: ['vm 104', 'pbs'] });
  assert.deepEqual(parseReply('{"summary":"s","tags":["deploys"]}', { vocabulary: new Set(['deploy']) }).tags, ['deploy']);
  assert.throws(() => parseReply('no json here'), /no JSON/);
  assert.throws(() => parseReply('{"summary": '), /no JSON|did not parse/);
  assert.throws(() => parseReply('[1,2]'), /no JSON|not an object/);
  assert.throws(() => parseReply('{"summary":"","tags":["chat"]}'), /neither/);
});

test('effectiveTags: user removals and additions win over the model', () => {
  assert.deepEqual(effectiveTags({ auto: ['a', 'b'], added: ['c', 'a'], removed: ['b'] }), ['a', 'c']);
});

test('estimateCost: known cheap model priced, others unknown', () => {
  const usd = estimateCost([4000, 100_000], 'anthropic/claude-haiku-4-5-20251001');
  assert.ok(usd > 0.005 && usd < 0.02, String(usd));
  assert.equal(estimateCost([4000], 'anthropic/claude-opus-5-5'), null);
  assert.equal(estimateCost([4000], null), null);
  assert.equal(estimateCost([4000], 'claude-cli/claude-haiku-4-5-20251001'), null, 'subscription');
});

test('tagsModelFromConfig: the owner\'s tag model from the gateway config, else null', () => {
  const cfg = model => ({ plugins: { entries: { connector: { config: { tags: { model } } } } } });
  assert.equal(tagsModelFromConfig(cfg(' haiku '), 'connector'), 'haiku');
  assert.equal(tagsModelFromConfig(cfg('anthropic/claude-haiku-5-5'), 'connector'), 'anthropic/claude-haiku-5-5');
  assert.equal(tagsModelFromConfig(cfg(''), 'connector'), null);
  assert.equal(tagsModelFromConfig(cfg(42), 'connector'), null);
  assert.equal(tagsModelFromConfig({ plugins: { entries: { connector: { config: {} } } } }, 'connector'), null);
  assert.equal(tagsModelFromConfig(undefined, 'connector'), null);
});
