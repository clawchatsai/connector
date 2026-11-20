import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchStore } from './store.js';
import { SearchIndexer } from './indexer.js';
import { SessionLens } from '../session-lens.js';

const A = 'agent:main:dashboard:a', B = 'agent:main:dashboard:b';
const SECRET = 'agent:main:dashboard:incog', CRON = 'agent:main:cron:job';
const quiet = { info() {}, warn() {} };

const msg = (id, role, text, extra = {}) => ({ role, content: [{ type: 'text', text }], timestamp: Number(id.replace(/\D/g, '')) || 1, __openclaw: { id, ...extra } });
const comment = (id, url) => ({ role: 'user', content: '', timestamp: 1, __openclaw: { id, media: [{ url, fileName: 'selection-comment.txt', contentType: 'text/plain' }] } });
const commentBody = (text, c) => `Selected text:\n${text}\n\nUser comment:\n${c}\n\nSource session: ${A}\nSelected text UTF-16 length: ${text.length}\nDOM text UTF-16 range: [0, 1)`;

/**
 * A gateway with sessions and transcripts. chat.history pages newest-first by offset, hands out a
 * delta cursor `<sessionId>:<count>` on the first page, and answers a cursor with the appended
 * entries, or `reset` after a branch change / window reset.
 */
function fakeGateway({ delta = true } = {}) {
  const chats = new Map(); // key -> { row, sessionId, messages, branchChanged }
  const calls = [];
  const failing = new Set();
  const full = new Map(); // messageId -> whole message (chat.message.get)
  const add = (key, messages = [], row = {}) => chats.set(key, { row: { key, kind: 'direct', createdVia: 'operator', updatedAt: 1, ...row }, sessionId: 's1', messages, branchChanged: false });
  async function request(method, p) {
    calls.push({ method, ...p });
    if (method === 'sessions.list') return { sessions: [...chats.values()].map(c => c.row), hasMore: false };
    const c = chats.get(p.sessionKey);
    if (failing.has(p.sessionKey)) throw new Error('boom');
    if (method === 'chat.message.get') return full.has(p.messageId) ? { ok: true, message: full.get(p.messageId) } : { ok: false, unavailableReason: 'not_found' };
    if (method !== 'chat.history') throw new Error(`unexpected ${method}`);
    if (!c) throw new Error('session not found');
    if (p.cursor) {
      const [sid, n] = p.cursor.split(':');
      if (sid !== c.sessionId || c.branchChanged || Number(n) > c.messages.length) return { kind: 'reset' };
      // Real gateways wrap delta entries as session.message payloads.
      const appended = c.messages.slice(Number(n)).map(m => ({ sessionKey: p.sessionKey, agentId: 'main', message: m, messageId: m.__openclaw.id }));
      return { kind: 'delta', messages: appended, deltaCursor: `${c.sessionId}:${c.messages.length}` };
    }
    const n = c.messages.length, offset = p.offset || 0, limit = p.limit || 200;
    const start = Math.max(0, n - offset - limit);
    const page = c.messages.slice(start, n - offset);
    return { sessionId: c.sessionId, messages: page, totalMessages: n, hasMore: start > 0, nextOffset: offset + page.length,
      ...(delta && offset === 0 ? { deltaCursor: `${c.sessionId}:${n}` } : {}) };
  }
  return { chats, calls, failing, full, add, request };
}

function setup(gw, { files = {}, team = null } = {}) {
  const store = new SearchStore(null);
  const lens = new SessionLens({ broadcast() {}, logger: quiet });
  const fetched = [];
  let clock = 1_000_000;
  const indexer = new SearchIndexer({
    store, request: gw.request, lens, team, logger: quiet, quietMs: 5, maxWaitMs: 20, now: () => clock,
    fetchComment: async url => { fetched.push(url); return url in files ? files[url] : null; },
  });
  return { store, indexer, fetched, tick: ms => { clock += ms; } };
}

const keys = r => r.results.map(x => x.key).sort();

test('backfill: every visible chat indexed; incognito, cron and children stay out; then ready', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('m1', 'user', 'deploy the connector'), msg('m2', 'assistant', 'done, reload the plugin')]);
  gw.add(B, Array.from({ length: 450 }, (_, i) => msg(`b${i}`, 'assistant', `laser frame ${i}`)));
  gw.add(SECRET, [msg('s1', 'user', 'deploy secret')], { incognito: true });
  gw.add(CRON, [msg('c1', 'user', 'deploy cron')]);
  gw.add('agent:main:dashboard:child', [msg('k1', 'user', 'deploy child')], { spawnedBy: A, parentSessionKey: A });
  const { store, indexer } = setup(gw);
  assert.equal(indexer.status().ready, false);
  indexer.onConnected();
  await indexer.idle();
  assert.deepEqual(keys(store.search({ q: 'deplo' })), [A]);
  assert.equal(store.search({ q: 'frame' }).results[0].hits, 450, 'every page of a long chat');
  const st = indexer.status();
  assert.equal(st.ready, true);
  assert.equal(st.chats, 2);
  assert.equal(st.pending, 0);
});

test('live changes: appended entries arrive through the delta cursor, no full re-read', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('m1', 'user', 'first words')]);
  const { store, indexer, tick } = setup(gw);
  indexer.onConnected();
  await indexer.idle();
  gw.chats.get(A).messages.push(msg('m2', 'assistant', 'galvanometer tuning'));
  gw.calls.length = 0;
  tick(10);
  indexer.onSessionsChanged({ sessionKey: A, reason: 'message', session: { kind: 'direct', createdVia: 'operator', updatedAt: 2 } });
  await indexer.idle();
  assert.equal(store.search({ q: 'galvan' }).results[0].key, A);
  assert.ok(gw.calls.every(c => c.method !== 'chat.history' || c.cursor), 'delta only');
  // A change with nothing new is a single delta round.
  gw.calls.length = 0;
  tick(10);
  indexer.onSessionsChanged({ sessionKey: A, reason: 'patch' });
  await indexer.idle();
  assert.equal(gw.calls.length, 1);
});

test('branch change or window reset: the gateway refuses the cursor and the chat is re-read whole', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('m1', 'user', 'keep this'), msg('m2', 'assistant', 'rewound away')]);
  const { store, indexer, tick } = setup(gw);
  indexer.onConnected();
  await indexer.idle();
  gw.chats.get(A).messages = [msg('m1', 'user', 'keep this'), msg('m3', 'assistant', 'new branch reply')];
  gw.chats.get(A).branchChanged = true;
  tick(10);
  indexer.onSessionsChanged({ sessionKey: A, reason: 'rewind' });
  await indexer.idle();
  assert.equal(store.search({ q: 'rewound' }).results.length, 0);
  assert.equal(store.search({ q: 'branch' }).results[0].key, A);
  assert.equal(store.search({ q: 'keep' }).results.length, 1);
});

test('without a delta cursor: an unchanged chat costs one probe, a changed one a full read', async () => {
  const gw = fakeGateway({ delta: false });
  gw.add(A, [msg('m1', 'user', 'alpha')]);
  const { store, indexer, tick } = setup(gw);
  indexer.onConnected();
  await indexer.idle();
  gw.calls.length = 0;
  tick(10);
  indexer.onSessionsChanged({ sessionKey: A, reason: 'patch' });
  await indexer.idle();
  assert.deepEqual(gw.calls.map(c => [c.method, c.limit]), [['chat.history', 1]]);
  gw.chats.get(A).messages.push(msg('m2', 'assistant', 'bravo'));
  tick(10);
  indexer.onSessionsChanged({ sessionKey: A, reason: 'message' });
  await indexer.idle();
  assert.equal(store.search({ q: 'bravo' }).results[0].key, A);
});

test('deletes, incognito and reconcile after a missed event', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('m1', 'user', 'apple')]);
  gw.add(B, [msg('m2', 'user', 'apple pie')]);
  const { store, indexer } = setup(gw);
  indexer.onConnected();
  await indexer.idle();
  gw.chats.delete(A);
  indexer.onSessionsChanged({ sessionKey: A, reason: 'delete' });
  assert.deepEqual(keys(store.search({ q: 'apple' })), [B]);
  gw.chats.get(B).row.incognito = true;
  indexer.onSessionsChanged({ sessionKey: B, reason: 'patch', session: { kind: 'direct', createdVia: 'operator', incognito: true } });
  assert.equal(store.search({ q: 'apple' }).results.length, 0);
  // Deleted while the connector wasn't listening: the next roster pass drops it.
  gw.chats.get(B).row.incognito = false;
  indexer.store.upsertChat({ key: B, stamp: 1 });
  gw.chats.delete(B);
  gw.add('agent:main:dashboard:c', [msg('m3', 'user', 'cherry')]);
  await indexer.reconcile();
  await indexer.idle();
  assert.deepEqual(store.chatKeys().sort(), ['agent:main:dashboard:c']);
});

test('a roster reply without a session list fails the pass and keeps the index', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('m1', 'user', 'apple')]);
  const { store, indexer } = setup(gw);
  indexer.onConnected();
  await indexer.idle();
  const real = gw.request;
  indexer.request = async (method, p) => method === 'sessions.list' ? { ok: false, error: { code: 'UNAVAILABLE' } } : real(method, p);
  await assert.rejects(indexer.reconcile(), /no session list/);
  assert.deepEqual(store.chatKeys(), [A]);
});

test('titles and archive state follow the gateway without re-reading transcripts', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('m1', 'user', 'x')], { label: 'Proxmox restore', archived: false });
  const { store, indexer, tick } = setup(gw);
  indexer.onConnected();
  await indexer.idle();
  assert.equal(store.search({ q: 'proxm' }).results[0].titleMatch, true);
  tick(10);
  indexer.onSessionsChanged({ sessionKey: A, reason: 'patch', session: { kind: 'direct', createdVia: 'operator', label: 'Homiox backups', archived: true } });
  assert.equal(store.search({ q: 'proxm' }).results.length, 0);
  assert.equal(store.search({ q: 'homiox' }).results[0].archived, true);
});

test('selection comments: fetched once, cached, missing files skipped', async () => {
  const gw = fakeGateway();
  const url = 'media://inbound/selection-comment---1.txt';
  gw.add(A, [comment('u1', url), comment('u2', 'media://inbound/selection-comment---gone.txt')]);
  const { store, indexer, fetched } = setup(gw, { files: { [url]: commentBody('scan rate is 20k', 'make the galvo faster') } });
  indexer.onConnected();
  await indexer.idle();
  const hit = store.search({ q: 'galvo' }).results[0];
  assert.equal(hit.snippets[0].kind, 'comment');
  assert.equal(hit.snippets[0].messageId, 'u1');
  assert.equal(store.search({ q: 'scan rate' }).results.length, 1);
  await indexer.syncChat(A, { full: true });
  assert.equal(fetched.filter(u => u === url).length, 1, 'cached after the first read');
});

test('display-capped entries are fetched whole', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('m1', 'assistant', 'start of a long reply…', { truncated: true, reason: 'display-cap' })]);
  gw.full.set('m1', msg('m1', 'assistant', 'start of a long reply and the needle at the end'));
  const { store, indexer } = setup(gw);
  indexer.onConnected();
  await indexer.idle();
  assert.equal(store.search({ q: 'needle' }).results[0].key, A);
});

test('a failing chat is recorded, retried after its backoff, and does not block the others', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('m1', 'user', 'alpha')]);
  gw.add(B, [msg('m2', 'user', 'beta')]);
  gw.failing.add(A);
  const { store, indexer, tick } = setup(gw);
  indexer.onConnected();
  await indexer.idle();
  assert.equal(store.search({ q: 'beta' }).results.length, 1);
  assert.equal(store.getChat(A).error, 'boom');
  assert.equal(indexer.status().failed, 1);
  assert.equal(indexer.status().ready, false, 'not complete while a chat has never been indexed');
  gw.failing.delete(A);
  tick(31_000);
  await indexer.syncChat(A); // what the retry timer runs
  assert.equal(store.search({ q: 'alpha' }).results.length, 1);
  assert.equal(store.getChat(A).error, null);
});

test('team rooms: entries attributed through the room author map', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('e1', 'assistant', '[Houman]\n\nship the laser'), msg('e2', 'assistant', '[homiabot]\n\nshipping the laser'), msg('e3', 'assistant', '[System]\n\nKamil joined')]);
  const team = { room: key => key === A ? { authors: { e1: { type: 'user' }, e2: { type: 'agent', agentId: 'main' }, e3: { type: 'system' } } } : null };
  const { store, indexer } = setup(gw, { team });
  indexer.onConnected();
  await indexer.idle();
  assert.deepEqual(store.search({ q: 'laser', role: 'user' }).results[0].snippets.map(s => s.messageId), ['e1']);
  assert.equal(store.search({ q: 'joined' }).results.length, 0);
});

test('rebuild empties the index and fills it again', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('m1', 'user', 'alpha')]);
  const { store, indexer } = setup(gw);
  indexer.onConnected();
  await indexer.idle();
  await indexer.rebuild();
  await indexer.idle();
  assert.equal(store.search({ q: 'alpha' }).results.length, 1);
  assert.equal(indexer.status().ready, true);
});

test('a connector update that changes indexing re-reads every chat', async () => {
  const gw = fakeGateway();
  gw.add(A, [msg('m1', 'user', 'alpha')]);
  const { store, indexer } = setup(gw);
  indexer.onConnected();
  await indexer.idle();
  store.db.prepare("UPDATE meta SET v = '1' WHERE k = 'indexer'").run();
  gw.calls.length = 0;
  const next = new SearchIndexer({ store, request: gw.request, lens: new SessionLens({ broadcast() {}, logger: quiet }), logger: quiet, fetchComment: async () => null, quietMs: 5 });
  assert.equal(store.search({ q: 'alpha' }).results.length, 1, 'still searchable while it re-reads');
  next.onConnected();
  await next.idle();
  assert.ok(gw.calls.some(c => c.method === 'chat.history' && !c.cursor && c.limit === 200), 'full read');
  assert.deepEqual(store.staleKeys(), []);
});
