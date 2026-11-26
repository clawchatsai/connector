import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validBase, chatLink, createChatLinks, chatLinkTool, chatMessagesTool, entryId, messageSummary, currentTurnEntry, DEFAULT_APP_BASE } from './chat-link.js';

const KEY = 'agent:main:dashboard:11111111-2222-4333-8444-555555555555';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-link-test-'));

test('the link format is the app\'s: ?gateway=&session=, the key encoded', () => {
  assert.equal(chatLink('https://next.clawchats.ai/', 'gw_1', KEY), `https://next.clawchats.ai/?gateway=gw_1&session=${encodeURIComponent(KEY)}`);
  assert.equal(chatLink('https://app.clawchats.ai/next/slot/', '', 'agent:main:main'), 'https://app.clawchats.ai/next/slot/?session=agent%3Amain%3Amain');
});

test('only an app address counts as an app base', () => {
  assert.equal(validBase('https://next.clawchats.ai/'), 'https://next.clawchats.ai/');
  assert.equal(validBase('https://app.clawchats.ai/next/chat-links/'), 'https://app.clawchats.ai/next/chat-links/');
  assert.equal(validBase('http://localhost:8443/'), 'http://localhost:8443/');
  for (const bad of ['http://evil.example/', 'javascript:alert(1)//', 'https://x.example/page', 'https://x.example/?a=1', 'https://x.example/#h',
    'https://u:p@x.example/', '', 7, null, 'https://x.example/' + 'a'.repeat(300) + '/']) assert.equal(validBase(bad), null, String(bad));
});

test('the last reported base wins and survives a restart; none reported → app.clawchats.ai', () => {
  const dataDir = tmp();
  const a = createChatLinks({ dataDir });
  assert.equal(a.base(), DEFAULT_APP_BASE);
  assert.equal(a.setBase('https://evil.example/x'), false);
  assert.equal(a.base(), DEFAULT_APP_BASE);
  assert.equal(a.setBase('https://next.clawchats.ai/'), true);
  assert.equal(createChatLinks({ dataDir }).base(), 'https://next.clawchats.ai/');
  fs.rmSync(dataDir, { recursive: true });
});

test('a link for a chat on this gateway; an unknown chat or a bad key fails loudly', async () => {
  const dataDir = tmp();
  const links = createChatLinks({ dataDir, gatewayId: () => 'gw_1', sessionExists: async k => k === KEY });
  links.setBase('https://next.clawchats.ai/');
  assert.deepEqual(await links.link(KEY), { url: `https://next.clawchats.ai/?gateway=gw_1&session=${encodeURIComponent(KEY)}`, gatewayId: 'gw_1', sessionKey: KEY });
  assert.match((await links.link('agent:main:nope')).error, /No chat agent:main:nope/);
  assert.match((await links.link('')).error, /sessionKey/);
  assert.match((await links.link('a\nb')).error, /sessionKey/);
  // the gateway can't tell (busy, older): the link is still made; no gateway id saved yet: a link without one
  const unsure = createChatLinks({ dataDir, sessionExists: async () => null });
  assert.equal((await unsure.link(KEY)).url, `https://next.clawchats.ai/?session=${encodeURIComponent(KEY)}`);
  fs.rmSync(dataDir, { recursive: true });
});

// A transcript as chat.history returns it: entries with __openclaw.id, an assistant entry holding a tool call.
const entry = (id, role, content, extra = {}) => ({ role, content, timestamp: 1795700000000, __openclaw: { id, seq: 1 }, ...extra });
function transcript(n = 250) {
  const all = [];
  for (let i = 0; i < n; i++) all.push(entry(`e${i}`, i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `line ${i}\nmore` }]));
  all.push(entry('e-report', 'assistant', [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'REPORT-XYZ' }, { type: 'toolCall', id: 'toolu_1', name: 'clawchats_link' }]));
  return all;
}
/** chat.history over `all`: newest page first, `nextOffset` = entries already returned from the end. */
const historyOf = (all, calls = []) => async (key, { limit, offset = 0 }) => {
  calls.push({ key, limit, offset });
  const end = all.length - offset, start = Math.max(0, end - limit);
  return { messages: all.slice(start, end), hasMore: start > 0, nextOffset: offset + (end - start) };
};

test('message "this" is the turn being written: its first assistant entry after the newest user message', async () => {
  const dataDir = tmp();
  // As 2026.11.6 stores a Tool Search call: the assistant entry holds dispatch_action, a custom entry the inner call.
  const all = [...transcript(4),
    entry('u-last', 'user', 'Write the report and link it'),
    entry('a-1', 'assistant', [{ type: 'toolCall', id: 'toolu_A', name: 'tool_describe' }]),
    entry('r-1', 'toolResult', [{ type: 'text', text: '{}' }], { toolCallId: 'toolu_A' }),
    entry('a-2', 'assistant', [{ type: 'text', text: 'STATUS REPORT' }, { type: 'toolCall', id: 'toolu_B', name: 'dispatch_action' }]),
    entry('c-1', 'custom', [{ type: 'toolCall', id: 'tool_call:toolu_B:clawchats_link:1' }])];
  const links = createChatLinks({ dataDir, gatewayId: () => 'gw_1', history: historyOf(all) });
  const r = await links.link(KEY, { thisTurn: true });
  assert.equal(r.messageId, 'a-1', 'the turn\'s first entry: the app shows the whole turn as one message');
  assert.equal(r.url, `${DEFAULT_APP_BASE}?gateway=gw_1&session=${encodeURIComponent(KEY)}&message=a-1`);
  assert.equal(currentTurnEntry([entry('a0', 'assistant', 'x')]), null, 'no user message on the page: no anchor');
  fs.rmSync(dataDir, { recursive: true });
});

test('the reply may land a moment after the call starts; never there → a clear error, no link', async () => {
  const dataDir = tmp();
  const all = [...transcript(3), entry('u', 'user', 'go')];
  let reads = 0;
  const late = async (k, p) => { if (++reads === 3) all.push(entry('e-late', 'assistant', [{ type: 'toolCall', id: 'x' }])); return historyOf(all)(k, p); };
  const links = createChatLinks({ dataDir, history: late, wait: async () => {} });
  assert.equal((await links.link(KEY, { thisTurn: true })).messageId, 'e-late');
  const none = createChatLinks({ dataDir, history: historyOf([entry('u2', 'user', 'go')]), wait: async () => {} });
  const r = await none.link(KEY, { thisTurn: true });
  assert.match(r.error, /not in the transcript yet/);
  assert.equal(r.url, undefined);
  fs.rmSync(dataDir, { recursive: true });
});

test('an earlier message by id: found by paging back (bounded); an unknown id fails loudly', async () => {
  const dataDir = tmp(), calls = [];
  const links = createChatLinks({ dataDir, history: historyOf(transcript(), calls) });
  assert.equal((await links.link(KEY, { messageId: 'e3' })).messageId, 'e3');
  assert.deepEqual(calls.map(c => c.offset), [0, 100, 200], 'newest page first, then older');
  calls.length = 0;
  assert.match((await links.link(KEY, { messageId: 'nope' })).error, /No message nope/);
  assert.ok(calls.length <= 10);
  assert.match((await links.link(KEY, { messageId: 'a\nb' })).error, /messageId/);
  assert.match((await createChatLinks({ dataDir }).link(KEY, { messageId: 'e3' })).error, /transcript/, 'no history reader: says so');
  fs.rmSync(dataDir, { recursive: true });
});

test('clawchats_messages lists user/assistant messages with text, ids from the transcript, newest last', async () => {
  const dataDir = tmp();
  const all = [...transcript(4), entry('t1', 'toolResult', [{ type: 'text', text: 'tool output' }]), entry('e-empty', 'assistant', [{ type: 'toolCall', id: 'x' }])];
  const links = createChatLinks({ dataDir, history: historyOf(all) });
  const r = await links.messages(KEY, 3);
  assert.deepEqual(r.messages.map(m => m.id), ['e2', 'e3', 'e-report']);
  assert.deepEqual(r.messages[0], { id: 'e2', role: 'user', time: new Date(1795700000000).toISOString(), text: 'line 2' });
  assert.equal(messageSummary(entry('long', 'user', 'x'.repeat(300))).text.length, 160);
  assert.equal(entryId({ __openclaw: { id: 'a' } }), 'a');
  assert.equal(entryId({ content: 'no meta' }), null);
  fs.rmSync(dataDir, { recursive: true });
});

test('the tools: "this" only for the calling chat, not with messageId; messages defaults to this chat', async () => {
  const seen = [];
  const links = { link: async (k, o) => { seen.push([k, o]); return { url: 'u' }; }, messages: async (k, n) => ({ k, n }) };
  const t = chatLinkTool(() => links).create({ sessionKey: KEY });
  await t.execute('toolu_9', { message: 'this' });
  assert.deepEqual(seen.pop(), [KEY, { thisTurn: true }]);
  await t.execute('toolu_9', { messageId: 'e3', sessionKey: 'agent:main:other' });
  assert.deepEqual(seen.pop(), ['agent:main:other', { messageId: 'e3' }]);
  assert.match((await t.execute('1', { message: 'this', sessionKey: 'agent:main:other' })).details.error, /this chat/);
  assert.match((await t.execute('1', { message: 'this', messageId: 'e3' })).details.error, /not both/);
  const m = chatMessagesTool(() => links).create({ sessionKey: KEY });
  assert.deepEqual((await m.execute('1', { limit: 5 })).details, { k: KEY, n: 5 });
  assert.equal(chatMessagesTool(() => links).create({ senderIsOwner: false }), null);
});

test('the tool links the calling chat by default, another one when asked, and is not offered to other people', async () => {
  const seen = [];
  const links = { link: async k => { seen.push(k); return { url: `u:${k}` }; } };
  const tool = chatLinkTool(() => links);
  assert.equal(tool.create({ senderIsOwner: false, sessionKey: KEY }), null);
  const t = tool.create({ senderIsOwner: true, sessionKey: KEY });
  assert.equal(t.name, 'clawchats_link');
  assert.deepEqual((await t.execute('1', {})).details, { url: `u:${KEY}` });
  assert.deepEqual((await t.execute('2', { sessionKey: 'agent:main:other' })).details, { url: 'u:agent:main:other' });
  assert.deepEqual(seen, [KEY, 'agent:main:other']);
  assert.ok(tool.create({ sessionKey: KEY }), 'a cron or host turn without the owner bit still gets it');
  assert.match((await chatLinkTool(() => null).create({}).execute('3', {})).details.error, /starting/);
});
