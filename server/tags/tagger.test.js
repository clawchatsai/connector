import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Database } from '../bootstrap/native.js';
import { SearchStore } from '../search/store.js';
import { createTagStore } from './store.js';
import { Tagger } from './tagger.js';

const quiet = { info() {}, warn() {} };
const A = 'agent:main:dashboard:a', B = 'agent:main:dashboard:b', OLD = 'agent:main:dashboard:old';
const reply = (o = {}) => JSON.stringify({ summary: 'Restored VM 104 from backup.', tags: ['Proxmox', 'backups'], keywords: ['vm 104'], ...o });

/** A model that answers from a queue of replies (text, or an Error to throw) and records its calls. */
function fakeLlm(...replies) {
  const calls = [];
  return {
    calls,
    async complete(p) {
      calls.push(p);
      const r = replies.length > 1 ? replies.shift() : replies[0];
      if (r instanceof Error) throw r;
      return { text: r, provider: p.model ? p.model.split('/')[0] : 'anthropic', model: p.model ? p.model.split('/')[1] : 'claude-opus-5-5', usage: { costUsd: 0.002 } };
    },
  };
}

function setup({ llm = fakeLlm(reply()), since = 1000, legacy = [], model } = {}) {
  const search = new SearchStore(null);
  let clock = 5000;
  const db = new Database(':memory:');
  const tags = createTagStore(() => db, { now: () => clock });
  const indexer = new EventEmitter();
  tags.setMeta('since', since);
  const tagger = new Tagger({ tags, search, indexer, llm, model, legacy: () => legacy, logger: quiet, now: () => clock, quietMs: 5, gapMs: 0, sweepMs: 60_000 });
  const chat = (key, n, { stamp = 2000, title = 'A chat', text = i => `message ${i} about the backup` } = {}) => {
    search.upsertChat({ key, title, stamp });
    search.writeDocs(key, Array.from({ length: n }, (_, i) => ({ messageId: `${key}-${i}`, kind: 'message', role: i % 2 ? 'assistant' : 'user', ts: i, text: text(i) })),
      { full: true, sessionId: 's', cursor: null, stamp, now: clock });
  };
  const settle = async () => { await new Promise(r => setTimeout(r, 30)); await tagger.draining; };
  return { search, tags, indexer, tagger, chat, settle, llm, tick: ms => { clock += ms; } };
}

test('a new chat is tagged once it has 6 messages and went quiet; short chats are not', async () => {
  const t = setup();
  t.tagger.start();
  t.chat(A, 6);
  t.chat(B, 5);
  t.indexer.emit('synced', A);
  t.indexer.emit('synced', B);
  await t.settle();
  assert.deepEqual(t.tags.get(A).tags, ['proxmox', 'backups']);
  assert.equal(t.tags.get(A).messages, 6);
  assert.equal(t.tags.get(B), null);
  assert.equal(t.llm.calls.length, 1);
  assert.equal(t.llm.calls[0].model, 'anthropic/claude-haiku-5-5');
  assert.equal(t.llm.calls[0].purpose, 'clawchats.tags');
  // Searchable: by tag word, by summary, and #tag lists it.
  assert.equal(t.search.search({ q: 'proxm' }).results[0].tagMatch, true);
  assert.equal(t.search.search({ q: 'restored' }).results[0].summaryMatch, true);
  assert.deepEqual(t.search.search({ q: '#proxmox' }).results.map(r => r.key), [A]);
  assert.deepEqual(t.search.search({ q: '#proxmox backup' }).results.map(r => r.key), [A]);
  assert.deepEqual(t.search.search({ q: '#nope' }).results, []);
  assert.deepEqual(t.search.search({ q: '#prox' }).results.map(r => r.key), [A], 'prefix, while typing');
  t.tagger.close();
});

test('history waits for the backfill offer; the estimate comes from measured cost once there is some', async () => {
  const t = setup();
  t.chat(OLD, 8, { stamp: 500 });
  t.tagger.start();
  await t.settle();
  assert.equal(t.llm.calls.length, 0);
  let s = t.tagger.status();
  assert.equal(s.backfill.state, null);
  assert.equal(s.backfill.chats, 1);
  assert.ok(s.backfill.costUsd >= 0, 'priced for Haiku before any measurement');
  t.tagger.setBackfill('accepted');
  await t.settle();
  assert.deepEqual(t.tags.get(OLD).tags, ['proxmox', 'backups']);
  s = t.tagger.status();
  assert.equal(s.backfill.chats, 0);
  assert.equal(s.tagged, 1);
  // Activity in a history chat makes it a current chat: tagged without the offer.
  const u = setup();
  u.chat(OLD, 8, { stamp: 500 });
  u.tagger.start();
  u.tagger.setBackfill('declined');
  u.chat(OLD, 9, { stamp: 3000 });
  u.indexer.emit('synced', OLD);
  await u.settle();
  assert.equal(u.tags.get(OLD).source, 'auto');
  t.tagger.close(); u.tagger.close();
});

test('cheap model not allowed: refused before inference, the default model tags; status says so', async () => {
  const refused = Object.assign(new Error('model override not allowed'), { code: 'LLM_COMPLETION_NOT_AUTHORIZED' });
  const llm = fakeLlm(refused, reply());
  const t = setup({ llm });
  t.tagger.start();
  t.chat(A, 6);
  t.indexer.emit('synced', A);
  await t.settle();
  assert.deepEqual(llm.calls.map(c => c.model ?? null), ['anthropic/claude-haiku-5-5', null]);
  assert.equal(t.tags.get(A).model, 'anthropic/claude-opus-5-5');
  const s = t.tagger.status();
  assert.equal(s.cheapModelRefused, true);
  assert.equal(s.model, 'anthropic/claude-opus-5-5');
  // The next chat goes straight to the default (no second refusal round-trip).
  t.chat(B, 6);
  t.indexer.emit('synced', B);
  await t.settle();
  assert.equal(llm.calls.at(-1).model, undefined);
  assert.equal(llm.calls.length, 3);
  t.tagger.close();
});

test('a cheap model whose provider fails falls through to the next one', async () => {
  const llm = { calls: [], async complete(p) {
    this.calls.push(p.model ?? null);
    if (p.model?.startsWith('anthropic/')) return { stopReason: 'error', errorMessage: 'No API key found for provider anthropic' };
    return { text: reply(), provider: 'claude-cli', model: 'claude-haiku-5-5' };
  } };
  const t = setup({ llm });
  t.tagger.start();
  t.chat(A, 6);
  t.indexer.emit('synced', A);
  await t.settle();
  assert.deepEqual(llm.calls, ['anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-5-5', 'claude-cli/claude-haiku-5-5']); // direct, agent runtime, next candidate
  assert.equal(t.tags.get(A).model, 'claude-cli/claude-haiku-5-5');
  t.tagger.close();
});

test('user edits survive a re-tag; growth by half re-tags; Re-tag runs regardless', async () => {
  const llm = fakeLlm(reply(), reply({ tags: ['proxmox', 'zfs'] }), reply({ tags: ['zfs'] }));
  const t = setup({ llm });
  t.tagger.start();
  t.chat(A, 6);
  t.indexer.emit('synced', A);
  await t.settle();
  t.tags.edit(A, { add: ['Home Lab'], remove: ['backups'] });
  assert.deepEqual(t.tags.get(A).tags, ['proxmox', 'home-lab']);
  t.chat(A, 12);                           // not yet 6 + 10
  t.indexer.emit('synced', A);
  await t.settle();
  assert.equal(llm.calls.length, 1);
  t.chat(A, 16);
  t.indexer.emit('synced', A);
  await t.settle();
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(t.tags.get(A).tags, ['proxmox', 'zfs', 'home-lab']);
  t.tagger.retag(A);
  await t.settle();
  assert.equal(llm.calls.length, 3);
  assert.deepEqual(t.tags.get(A).tags, ['zfs', 'home-lab']);
  assert.throws(() => t.tagger.retag('agent:main:dashboard:nope'), /isn't in the search index/);
  t.tagger.close();
});

test('failures back off and show in status; a gateway reload is not a failure', async () => {
  const boom = new Error('rate limited');
  const llm = fakeLlm(boom, boom, boom);
  const t = setup({ llm });
  t.tagger.start();
  t.chat(A, 6);
  t.indexer.emit('synced', A);
  await t.settle();
  const row = t.tags.get(A);
  // Direct, then the isolated retry (createCompletion); never the pricier default.
  assert.deepEqual([...new Set(llm.calls.map(c => c.model ?? null))], ['anthropic/claude-haiku-5-5'], 'transient: no fall-through to a pricier model');
  assert.equal(row.attempts, 1);
  assert.match(row.error, /rate limited/);
  assert.equal(t.tagger.status().failed, 1);
  assert.match(t.tagger.status().lastError.message, /rate limited/);
  const calls = llm.calls.length;
  t.tagger.sweep();
  await t.settle();
  assert.equal(llm.calls.length, calls, 'inside the backoff');
  t.tick(6 * 60_000);
  t.tagger.sweep();
  await t.settle();
  assert.equal(t.tags.get(A).attempts, 2);

  const lifecycle = Object.assign(new Error('reloading'), { code: 'LLM_RUNTIME_LIFECYCLE' });
  const u = setup({ llm: fakeLlm(lifecycle) });
  u.tagger.start();
  u.chat(B, 6);
  u.indexer.emit('synced', B);
  await u.settle();
  assert.equal(u.tags.get(B), null);
  t.tagger.close(); u.tagger.close();
});

test("the owner's tag model (config, e.g. a gateway alias) is the only one asked for; a change applies to the next chat", async () => {
  const llm = { calls: [], async complete(p) { this.calls.push(p.model ?? null); return { text: reply(), provider: 'anthropic', model: 'claude-haiku-5-5' }; } };
  let configured = 'haiku';
  const t = setup({ llm, model: () => configured });
  t.tagger.start();
  t.chat(A, 6);
  t.indexer.emit('synced', A);
  await t.settle();
  assert.deepEqual(llm.calls, ['haiku']);
  assert.equal(t.tags.get(A).model, 'anthropic/claude-haiku-5-5');
  assert.equal(t.tagger.status().requestedModel, 'haiku');
  configured = 'sonnet';
  t.chat(B, 6);
  t.indexer.emit('synced', B);
  await t.settle();
  assert.equal(llm.calls.at(-1), 'sonnet');
  configured = null; // none configured: the built-in cheap models
  assert.equal(t.tagger.status().requestedModel, 'anthropic/claude-haiku-5-5');
  t.tagger.close();
});

test("the owner's tag model refused by the gateway: the default model tags, no built-in model is tried instead", async () => {
  const refused = Object.assign(new Error('model override not allowed'), { code: 'LLM_COMPLETION_NOT_AUTHORIZED' });
  const llm = fakeLlm(refused, reply());
  const t = setup({ llm, model: () => 'haiku' });
  t.tagger.start();
  t.chat(A, 6);
  t.indexer.emit('synced', A);
  await t.settle();
  assert.deepEqual(llm.calls.map(c => c.model ?? null), ['haiku', null]);
  assert.equal(t.tagger.status().cheapModelRefused, true);
  t.tagger.close();
});

test('model check: the first usable model is found once, before any chat is tagged', async () => {
  const refused = Object.assign(new Error('override not allowed'), { code: 'LLM_COMPLETION_NOT_AUTHORIZED' });
  const t = setup({ llm: fakeLlm(refused, '{}') });
  await t.tagger.probe();
  assert.equal(t.tagger.status().model, 'anthropic/claude-opus-5-5');
  assert.equal(t.tagger.status().cheapModelRefused, true);
  assert.equal(t.tags.meta('model'), 'anthropic/claude-opus-5-5');
  const calls = t.llm.calls.length;
  await t.tagger.probe();
  assert.equal(t.llm.calls.length, calls, 'once');
  // A model this gateway doesn't know: the next candidate.
  const unknown = { calls: [], async complete(p) { this.calls.push(p.model ?? null); if (p.model?.startsWith('anthropic/')) throw new Error('Unknown model: anthropic/claude-haiku-5-5'); return { text: '{}', provider: 'claude-cli', model: 'claude-haiku-5-5' }; } };
  const u = setup({ llm: unknown });
  await u.tagger.probe();
  assert.equal(u.tagger.status().model, 'claude-cli/claude-haiku-5-5');
  assert.equal(u.tagger.status().cheapModelRefused, false);
});

test('plugin reload mid-call: no failure recorded, the model is not marked unusable', async () => {
  let release;
  const llm = { calls: 0, complete() { this.calls++; return new Promise((_, reject) => { release = () => reject(new Error('Plugin "connector" runtime is no longer active.')); }); } };
  const t = setup({ llm });
  t.tagger.start();
  t.chat(A, 6);
  t.indexer.emit('synced', A);
  for (let i = 0; i < 50 && !release; i++) await new Promise(r => setTimeout(r, 5));
  t.tagger.close();
  release();
  await t.tagger.draining;
  assert.equal(t.tags.get(A), null, 'nothing stored for the chat');
  assert.equal(t.tagger.status().cheapModelRefused, false);
  // Without a close (the host retired the runtime under a live instance): retried later, not a failure.
  let n = 0;
  const u = setup({ llm: { complete() { n++; return Promise.reject(new Error('Plugin "connector" runtime is no longer active.')); } } });
  u.tagger.start();
  u.chat(B, 6);
  u.indexer.emit('synced', B);
  await u.settle();
  assert.equal(u.tags.get(B), null);
  assert.equal(u.tagger.status().cheapModelRefused, false);
  assert.equal(n, 1, 'stopped at the first lifecycle refusal');
  u.tagger.close();
});

test('a garbage reply is a failure, not empty tags', async () => {
  const t = setup({ llm: fakeLlm('I cannot help with that.') });
  t.tagger.start();
  t.chat(A, 6);
  t.indexer.emit('synced', A);
  await t.settle();
  assert.deepEqual(t.tags.get(A).tags, []);
  assert.match(t.tags.get(A).error, /no JSON/);
  t.tagger.close();
});

test('disabled: nothing is tagged until it is switched back on', async () => {
  const t = setup();
  t.tagger.start();
  t.tagger.setEnabled(false);
  t.chat(A, 6);
  t.indexer.emit('synced', A);
  await t.settle();
  assert.equal(t.llm.calls.length, 0);
  t.tagger.setEnabled(true);
  await t.settle();
  assert.equal(t.llm.calls.length, 1);
  t.tagger.close();
});

test('removed chats lose their tags; legacy summaries import for live chats once the index is complete', async () => {
  const legacy = [{ key: OLD, summary: 'Old summary about galvos', keywords: ['galvanometer'], messages: 0 }, { key: 'agent:main:x:chat:gone', summary: 'gone', keywords: [] }];
  const t = setup({ legacy });
  t.chat(OLD, 3, { stamp: 500 });
  t.tagger.start();
  assert.equal(t.tags.get(OLD), null, 'index not complete yet');
  t.search.completedAt = 4000;
  t.tags.edit(A, { add: ['orphan'] }); // a row for a chat the index doesn't have
  t.indexer.emit('ready');
  assert.equal(t.tags.get(OLD).summary, 'Old summary about galvos');
  assert.equal(t.tags.get('agent:main:x:chat:gone'), null);
  assert.equal(t.tags.get(A), null, 'pruned');
  assert.equal(t.search.search({ q: 'galvanom' }).results[0].summaryMatch, true);
  assert.equal(t.tagger.status().backfill.chats, 0, 'too short to tag');
  t.search.deleteChat(OLD);
  t.indexer.emit('removed', OLD);
  assert.equal(t.tags.get(OLD), null);
  t.tagger.close();
});

test('rename, merge and delete apply everywhere and to future model output', async () => {
  const llm = fakeLlm(reply({ tags: ['proxmox'] }), reply({ tags: ['pve', 'junk'] }), reply({ tags: ['proxmox', 'junk'] }));
  const t = setup({ llm });
  t.tagger.start();
  t.chat(A, 6);
  t.chat(B, 6);
  t.indexer.emit('synced', A);
  await t.settle();
  t.indexer.emit('synced', B);
  await t.settle();
  assert.deepEqual(t.tags.get(B).tags, ['pve', 'junk']);
  t.tags.edit(A, { add: ['pve'] });
  assert.deepEqual(t.tags.renameTag('pve', 'proxmox').sort(), [A, B]);
  assert.deepEqual(t.tags.get(A).tags, ['proxmox']);
  assert.deepEqual(t.tags.get(B).tags, ['proxmox', 'junk']);
  t.tags.renameTag('junk', '');
  assert.deepEqual(t.tags.get(B).tags, ['proxmox']);
  t.tagger.retag(B);
  await t.settle();
  assert.deepEqual(t.tags.get(B).tags, ['proxmox'], 'deleted tag stays deleted');
  assert.deepEqual(t.tags.vocabulary(), [{ tag: 'proxmox', count: 2 }]);
  // Renaming back makes the old name live again.
  t.tags.renameTag('proxmox', 'pve');
  assert.equal(t.tags.aliases().has('pve'), false);
  assert.equal(t.tags.aliases().get('proxmox'), 'pve');
  t.tagger.close();
});
