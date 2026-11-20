import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SearchStore, toFtsQuery, SNIPPET_OPEN, SNIPPET_CLOSE } from './store.js';

const A = 'agent:main:dashboard:a', B = 'agent:main:dashboard:b', C = 'agent:main:dashboard:c';
const now = 1000;

function seeded() {
  const s = new SearchStore(null);
  s.upsertChat({ key: A, title: 'Connector deploy notes', stamp: 1 });
  s.upsertChat({ key: B, title: 'Laser show', stamp: 1 });
  s.upsertChat({ key: C, title: 'Old stuff', archived: true, stamp: 1 });
  s.writeDocs(A, [
    { messageId: 'a1', kind: 'message', role: 'user', ts: 10, text: 'how do we deploy the connector?' },
    { messageId: 'a2', kind: 'message', role: 'assistant', ts: 11, text: 'Run deploy-local.sh, then reload.' },
  ], { full: true, sessionId: 's', stamp: 1, now });
  s.writeDocs(B, [
    ...Array.from({ length: 30 }, (_, i) => ({ messageId: `b${i}`, kind: 'message', role: 'assistant', ts: 100 + i, text: `laser frame ${i} deployed` })),
    { messageId: 'b-c', kind: 'comment', ord: 0, role: 'user', ts: 200, text: 'make the galvo faster', quote: 'scan rate is 20k' },
  ], { full: true, sessionId: 's', stamp: 1, now });
  s.writeDocs(C, [{ messageId: 'c1', kind: 'message', role: 'user', ts: 5, text: 'archived deploy talk' }], { full: true, sessionId: 's', stamp: 1, now });
  return s;
}

test('query parsing: AND of prefixes, phrases, punctuation is text, caps', () => {
  assert.equal(toFtsQuery('deplo conn'), '"deplo"* AND "conn"*');
  assert.equal(toFtsQuery('"exact phrase" x'), '"exact phrase" AND "x"*');
  assert.equal(toFtsQuery('x OR y'), '"x"* AND "OR"* AND "y"*', 'operators are plain words');
  assert.equal(toFtsQuery('NEAR( -- ** )'), '"NEAR("*', 'punctuation-only terms dropped');
  assert.equal(toFtsQuery('-- ** ()'), null);
  assert.equal(toFtsQuery('   '), null);
  assert.equal(toFtsQuery('w '.repeat(40)).split(' AND ').length, 16);
});

test('awkward input never breaks a query', () => {
  const s = seeded();
  for (const q of ['a"b', '"unclosed', 'x*', 'col:umn', 'NOT', '^start', 'C++', 'sessions.search', '日本語', "it's", '\u0000', '""'])
    assert.doesNotThrow(() => s.search({ q }), q);
  assert.equal(s.search({ q: 'deploy-local' }).results[0].key, A);
});

test('partial words and inflections match; one row per chat with hit counts', () => {
  const s = seeded();
  const { results } = s.search({ q: 'deplo' });
  assert.deepEqual(results.map(r => r.key).sort(), [A, B, C].sort());
  const b = results.find(r => r.key === B);
  assert.equal(b.hits, 30);
  assert.equal(b.snippets.length, 3, 'top snippets per chat');
  assert.ok(b.snippets[0].snippet.includes(`${SNIPPET_OPEN}deployed${SNIPPET_CLOSE}`));
  assert.ok(s.search({ q: 'deploying' }).results.length === 3, 'porter stemming');
});

test('a long chat no longer crowds out the others', () => {
  const s = seeded();
  const { results } = s.search({ q: 'deploy', limit: 2 });
  assert.equal(results.length, 2);
  assert.ok(results.some(r => r.key === A), 'chat A has 2 hits and a title match: it ranks first-page');
});

test('title matches count, even without message hits; role filter and archived filter', () => {
  const s = seeded();
  const laser = s.search({ q: 'laser show' }).results;
  assert.equal(laser[0].key, B);
  assert.equal(laser[0].titleMatch, true);
  const t = s.search({ q: 'notes' }).results;
  assert.deepEqual(t.map(r => [r.key, r.hits, r.titleMatch]), [[A, 0, true]]);
  assert.deepEqual(s.search({ q: 'deploy', role: 'user' }).results.map(r => r.key).sort(), [A, C].sort());
  assert.ok(!s.search({ q: 'deploy', archived: false }).results.some(r => r.key === C));
  assert.equal(s.search({ q: 'deploy' }).results.find(r => r.key === C).archived, true);
});

test('comments are searchable by comment and by quoted passage', () => {
  const s = seeded();
  const byComment = s.search({ q: 'galvo' }).results;
  assert.equal(byComment[0].key, B);
  assert.equal(byComment[0].snippets[0].kind, 'comment');
  assert.equal(s.search({ q: 'scan rate' }).results[0].key, B);
});

test('full writes replace, delta writes upsert; chat delete and reset clear everything', () => {
  const s = seeded();
  s.writeDocs(A, [{ messageId: 'a9', kind: 'message', role: 'user', ts: 20, text: 'brand new words' }], { full: false, sessionId: 's', stamp: 2, now });
  assert.equal(s.search({ q: 'brand' }).results.length, 1);
  assert.equal(s.search({ q: 'reload' }).results.length, 1, 'delta keeps older docs');
  s.writeDocs(A, [{ messageId: 'a1', kind: 'message', role: 'user', ts: 10, text: 'edited text' }], { full: true, sessionId: 's2', stamp: 3, now });
  assert.equal(s.search({ q: 'brand' }).results.length, 0, 'full read drops docs no longer in history');
  assert.equal(s.search({ q: 'edited' }).results[0].key, A);
  assert.equal(s.getChat(A).docs, 1);
  assert.ok(s.deleteChat(B));
  assert.equal(s.search({ q: 'galvo' }).results.length, 0, 'cascade removes FTS rows');
  s.upsertChat({ key: A, title: 'Renamed chat', stamp: 3 });
  assert.equal(s.search({ q: 'renamed' }).results[0].key, A);
  assert.equal(s.search({ q: 'connector notes' }).results.length, 0, 'old title gone from the title index');
  s.reset();
  assert.equal(s.stats().chats, 0);
  assert.equal(s.search({ q: 'edited' }).results.length, 0);
});

test('stale tracking, failures, and the synced stamp', () => {
  const s = new SearchStore(null);
  s.upsertChat({ key: A, stamp: 5 });
  assert.deepEqual(s.staleKeys(), [A]);
  assert.equal(s.stats().neverIndexed, 1);
  s.writeDocs(A, [], { full: true, stamp: 5, now });
  assert.deepEqual(s.staleKeys(), []);
  s.upsertChat({ key: A, stamp: 4 });
  assert.equal(s.getChat(A).stamp, 5, 'stamps never go back');
  s.upsertChat({ key: A, stamp: 9 });
  s.markFailed(A, 'boom', now);
  assert.equal(s.getChat(A).attempts, 1);
  assert.deepEqual(s.staleKeys(), [A]);
  s.markSynced(A, 9, now);
  assert.equal(s.getChat(A).error, null);
  assert.deepEqual(s.staleKeys(), []);
});

test('comment file cache: bodies kept, missing files retried after a day', () => {
  const s = new SearchStore(null);
  s.putCommentFile('media://inbound/a.txt', 'body', now);
  assert.deepEqual(s.commentFile('media://inbound/a.txt', now), { body: 'body' });
  s.putCommentFile('media://inbound/b.txt', null, now);
  assert.deepEqual(s.commentFile('media://inbound/b.txt', now + 1000), { missing: true });
  assert.equal(s.commentFile('media://inbound/b.txt', now + 25 * 3600_000), null);
});

test('a schema change rebuilds the file instead of migrating it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'search-')), 'search.db');
  const s = seeded.call(null);
  s.close();
  const a = new SearchStore(file);
  a.upsertChat({ key: A, title: 'x', stamp: 1 });
  a.db.prepare("UPDATE meta SET v = '0' WHERE k = 'schema'").run();
  a.close();
  const b = new SearchStore(file);
  assert.equal(b.stats().chats, 0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  b.close();
});
