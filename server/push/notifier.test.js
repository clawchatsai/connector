import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PushNotifier, plainText, replyText } from './notifier.js';
import { PushStore, defaultPrefs, publicDevice } from './store.js';
import { Presence } from './presence.js';
import { VapidTokens } from './vapid.js';
import { decryptPayload, fakeSubscription } from '../../test/helpers/web-push.js';

const FCM = 'https://fcm.googleapis.com/fcm/send/';
const APPLE = 'https://web.push.apple.com/';

/** Fake clock + timers, a store in a temp dir, a push service that records (and decrypts) what it gets. */
function harness({ statuses = [], escalateMs = 120_000 } = {}) {
  let now = 1_000_000;
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn, done: false }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.done = true; },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const store = new PushStore(path.join(dir, 'push-subscriptions.json'));
  const presence = new Presence({ now: () => now });
  const vapidCalls = [];
  const vapid = new VapidTokens({ now: () => now, fetchToken: async aud => { vapidCalls.push(aud); return { jwt: 'jwt', exp: now / 1000 + 43200, publicKey: 'PUB' }; } });
  const subs = new Map(); // endpoint -> fake subscription
  const sent = [];
  const post = async (endpoint, body, opts) => {
    const s = subs.get(endpoint);
    sent.push({ endpoint, opts, payload: JSON.parse(decryptPayload(body, s.ua, s.auth)) });
    return statuses.length ? statuses.shift() : { status: 201, retryAfterMs: null };
  };
  const topLevel = new Set(['agent:main:dashboard:a', 'agent:main:dashboard:b']);
  const n = new PushNotifier({
    store, presence, vapid, post, escalateMs, now: () => now, timers: clock, log: { info() {}, warn() {} },
    lens: { isTopLevel: k => topLevel.has(k) },
    request: async m => (m === 'agents.list' ? { agents: [{ id: 'main', identity: { name: 'Jarvis' } }] } : null),
    gatewayId: () => 'gw_1', gatewayName: () => 'homebox',
  });
  const device = (endpoint, { mobile = false, prefs } = {}) => {
    const s = fakeSubscription();
    subs.set(endpoint, s);
    return store.upsert({ endpoint, keys: s.keys, deviceLabel: endpoint.startsWith(APPLE) ? 'iPhone' : 'Chrome on Linux', mobile, prefs });
  };
  const flush = () => new Promise(r => setImmediate(r));
  const advance = async ms => {
    now += ms;
    for (const t of timers.filter(t => !t.done && t.at <= now).sort((a, b) => a.at - b.at)) { t.done = true; t.fn(); }
    for (let i = 0; i < 5; i++) await flush();
  };
  const event = async (event, payload) => { n.onGatewayEvent({ type: 'event', event, payload }); for (let i = 0; i < 5; i++) await flush(); };
  const approval = async (event, payload) => { n.onApprovalEvent({ type: 'event', event, payload }); for (let i = 0; i < 5; i++) await flush(); };
  const final = (key, text, extra = {}) => event('chat', { sessionKey: key, state: 'final', runId: 'r', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
  const present = (on = true) => { presence.update('c1', { visible: on, focused: on, idleMs: 0 }); n.presenceChanged(); };
  return { n, store, presence, sent, vapidCalls, device, advance, event, approval, final, present, now: () => now };
}

test('markdown is stripped and the reply is the text after the last tool call', () => {
  assert.equal(plainText('## Done\n**Bold** and `code` with [a link](https://x)\n```js\nx()\n```\n- item'), 'Done Bold and code with a link item');
  assert.equal(replyText({ content: [{ type: 'text', text: 'Let me check.' }, { type: 'toolCall', name: 'exec' }, { type: 'text', text: 'All set.' }] }), 'All set.');
  assert.equal(replyText({ content: 'plain' }), 'plain');
  assert.equal(replyText(null), '');
});

test('device defaults: replies off on phones, on on desktops; the browser never sees endpoints', () => {
  const h = harness();
  const phone = h.device(`${FCM}phone`, { mobile: true });
  const desk = h.device(`${FCM}desk`);
  assert.equal(phone.prefs.replies, false);
  assert.equal(desk.prefs.replies, true);
  assert.deepEqual(defaultPrefs(true), { approvals: true, questions: true, replies: false, mentions: true, automationFailures: true, showPreviews: true });
  const pub = publicDevice(phone);
  assert.equal(pub.endpoint, undefined);
  assert.equal(pub.keys, undefined);
  // re-registering keeps its prefs
  h.store.setPrefs(phone.id, { replies: true });
  assert.equal(h.store.upsert({ endpoint: `${FCM}phone`, keys: phone.keys, mobile: true }).prefs.replies, true);
  // persisted with mode 0600 and reloaded
  const file = h.store.file;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(new PushStore(file).list().length, 2);
});

test('a reply pushes when away, with chat title, preview, gateway, badge count and chat tag', async () => {
  const h = harness();
  h.device(`${FCM}desk`);
  h.n.noteRow('agent:main:dashboard:a', { label: 'Trip plans', unread: true });
  await h.final('agent:main:dashboard:a', 'Here is the **itinerary** for `Rome`.');
  assert.equal(h.sent.length, 1);
  const { payload, opts } = h.sent[0];
  assert.equal(payload.title, 'Trip plans');
  assert.equal(payload.body, 'Here is the itinerary for Rome.');
  assert.equal(payload.tag, 'chat-agent:main:dashboard:a');
  assert.equal(payload.kind, 'reply');
  assert.equal(payload.gatewayId, 'gw_1');
  assert.equal(payload.gatewayName, 'homebox');
  assert.equal(payload.unread, 1);
  assert.equal(payload.renotify, true);
  assert.equal(opts.urgency, 'normal');
  assert.equal(opts.jwt, 'jwt');
  assert.deepEqual(h.vapidCalls, ['https://fcm.googleapis.com']);
  assert.ok(JSON.stringify(payload).length < 3000);
});

test('replies: nothing while present, nothing for hidden/sub-agent/automation sessions, nothing without text', async () => {
  const h = harness();
  h.device(`${FCM}desk`);
  h.present(true);
  await h.final('agent:main:dashboard:a', 'hello');
  h.present(false);
  await h.final('agent:main:subagent:x', 'child result');
  await h.final('agent:main:cron:job1', 'cron output');
  await h.final('agent:main:dashboard:a', '');
  await h.final('agent:main:dashboard:a', 'yielded', { yielded: true });
  assert.equal(h.sent.length, 0);
  // present but idle for more than 2 minutes is away
  h.present(true);
  await h.advance(121_000);
  await h.final('agent:main:dashboard:a', 'now');
  assert.equal(h.sent.length, 1);
});

test('follow-ups in one chat update in place ("3 new replies"), buzzing again only after 30 s; reading resets', async () => {
  const h = harness();
  h.device(`${FCM}desk`);
  h.n.noteRow('agent:main:dashboard:a', { label: 'Chat A' });
  await h.final('agent:main:dashboard:a', 'one');
  await h.advance(5000);
  await h.final('agent:main:dashboard:a', 'two');
  await h.advance(5000);
  await h.final('agent:main:dashboard:a', 'three');
  assert.deepEqual(h.sent.map(s => [s.payload.body, s.payload.renotify]), [['one', true], ['2 new replies · two', false], ['3 new replies · three', false]]);
  assert.ok(h.sent.every(s => s.payload.tag === 'chat-agent:main:dashboard:a' && s.opts.topic === h.sent[0].opts.topic));
  await h.advance(31_000);
  await h.final('agent:main:dashboard:a', 'four');
  assert.equal(h.sent.at(-1).payload.renotify, true);
  h.n.noteRow('agent:main:dashboard:a', { unread: false });
  await h.final('agent:main:dashboard:a', 'five');
  assert.equal(h.sent.at(-1).payload.body, 'five');
});

test('prefs per device: replies off on the phone, previews off hide content', async () => {
  const h = harness();
  h.device(`${FCM}phone`, { mobile: true });
  const desk = h.device(`${FCM}desk`, { prefs: { showPreviews: false } });
  h.n.noteRow('agent:main:dashboard:a', { label: 'Taxes' });
  await h.final('agent:main:dashboard:a', 'Your refund is $1,234');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].endpoint, `${FCM}desk`);
  assert.equal(h.sent[0].payload.title, 'ClawChats');
  assert.equal(h.sent[0].payload.body, 'New reply in Taxes');
  assert.ok(!JSON.stringify(h.sent[0].payload).includes('1,234'));
  h.store.setPrefs(desk.id, { replies: false });
  await h.final('agent:main:dashboard:a', 'again');
  assert.equal(h.sent.length, 1);
  // incognito chats never show their text
  h.store.setPrefs(desk.id, { replies: true, showPreviews: true });
  h.n.noteRow('agent:main:dashboard:b', { label: 'Secret', incognito: true });
  await h.final('agent:main:dashboard:b', 'hidden words');
  assert.equal(h.sent.at(-1).payload.body, 'New reply in Secret');
});

const execApproval = (id, extra = {}) => ({ id, createdAtMs: 1_000_000, expiresAtMs: 1_000_000 + 30 * 60_000, request: { command: 'rm -rf build && npm run deploy', sessionKey: 'agent:main:dashboard:a', agentId: 'main' }, ...extra });

test('an approval pushes at once when away: "<agent> wants to run `cmd`", high urgency, routed by approvalId', async () => {
  const h = harness();
  h.device(`${FCM}desk`);
  h.n.noteRow('agent:main:dashboard:a', { label: 'Deploy' });
  await h.approval('exec.approval.requested', execApproval('ap1'));
  assert.equal(h.sent.length, 1);
  const { payload, opts } = h.sent[0];
  assert.equal(payload.title, 'Deploy');
  assert.equal(payload.body, 'Jarvis wants to run `rm -rf build && npm run deploy`');
  assert.equal(payload.kind, 'approval');
  assert.equal(payload.tag, 'approval-ap1');
  assert.equal(payload.approvalId, 'ap1');
  assert.equal(payload.sessionKey, 'agent:main:dashboard:a');
  assert.equal(opts.urgency, 'high');
  assert.equal(opts.ttl, 1800);
  // the 2-minute escalation doesn't push it a second time
  await h.advance(120_000);
  assert.equal(h.sent.length, 1);
});

test('present: an approval waits, and goes out after 2 minutes if still pending (or when the owner leaves)', async () => {
  const h = harness();
  h.device(`${FCM}desk`);
  h.present(true);
  await h.approval('exec.approval.requested', execApproval('ap1'));
  assert.equal(h.sent.length, 0);
  await h.advance(119_000);
  h.present(true); // still typing
  assert.equal(h.sent.length, 0);
  await h.advance(1000);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].payload.escalated, true);
  // another one: the owner closes the window before 2 minutes
  await h.approval('plugin.approval.requested', { id: 'ap2', expiresAtMs: h.now() + 600_000, request: { title: 'Write file', description: 'Write /tmp/x.txt', agentId: 'main' } });
  assert.equal(h.sent.length, 1);
  h.n.presence.remove('c1'); h.n.presenceChanged();
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].payload.body, 'Jarvis: Write /tmp/x.txt');
});

test('resolved elsewhere or expired: replaced with Handled / Expired under the same tag, never to Apple devices', async () => {
  const h = harness();
  h.device(`${FCM}desk`);
  h.device(`${APPLE}iphone`, { mobile: true });
  await h.approval('exec.approval.requested', execApproval('ap1'));
  assert.equal(h.sent.length, 2);
  await h.approval('exec.approval.resolved', { id: 'ap1', decision: 'allow-once' });
  assert.equal(h.sent.length, 3);
  const done = h.sent[2];
  assert.equal(done.endpoint, `${FCM}desk`);
  assert.equal(done.payload.tag, 'approval-ap1');
  assert.equal(done.payload.kind, 'approval-done');
  assert.match(done.payload.body, /^Handled: Allowed once · /);
  assert.equal(done.payload.silent, true);
  // expiry
  await h.approval('exec.approval.requested', execApproval('ap2', { expiresAtMs: h.now() + 60_000 }));
  await h.advance(60_000);
  const expired = h.sent.filter(s => s.payload.kind === 'approval-done' && s.payload.tag === 'approval-ap2');
  assert.equal(expired.length, 1);
  assert.match(expired[0].payload.body, /^Expired · /);
  // a resolve for an approval nobody was pushed: nothing
  const before = h.sent.length;
  h.present(true);
  await h.approval('exec.approval.requested', execApproval('ap3'));
  await h.approval('exec.approval.resolved', { id: 'ap3', decision: 'deny' });
  await h.advance(130_000);
  assert.equal(h.sent.length, before);
});

test('questions and failed automations', async () => {
  const h = harness();
  h.device(`${FCM}desk`);
  h.n.noteRow('agent:main:dashboard:a', { label: 'Research' });
  await h.event('question.requested', { id: 'q1', sessionKey: 'agent:main:dashboard:a', agentId: 'main', expiresAtMs: h.now() + 600_000, questions: [{ questionId: 'a', header: 'Pick', question: 'Which **city**?', options: [] }] });
  assert.equal(h.sent.at(-1).payload.body, 'Jarvis asks: Which city?');
  assert.equal(h.sent.at(-1).payload.questionId, 'q1');
  await h.event('question.resolved', { id: 'q1', status: 'answered' });
  assert.match(h.sent.at(-1).payload.body, /^Answered · /);
  await h.event('cron', { action: 'finished', status: 'error', jobId: 'j1', runId: 'run1', error: 'Model timeout', job: { name: 'Morning brief' } });
  const cron = h.sent.at(-1).payload;
  assert.deepEqual([cron.kind, cron.title, cron.body, cron.jobId, cron.runId, cron.tag], ['automation', 'Automation failed', 'Morning brief: Model timeout', 'j1', 'run1', 'cron-j1']);
  await h.event('cron', { action: 'finished', status: 'ok', jobId: 'j1' });
  assert.equal(h.sent.at(-1).payload, cron);
});

test('push service answers: 410 removes the device, 413 shrinks, 429 retries after Retry-After, 401 renews the token', async () => {
  const h = harness({ statuses: [{ status: 410 }] });
  h.device(`${FCM}gone`);
  await h.final('agent:main:dashboard:a', 'x');
  assert.equal(h.store.list().length, 0);

  const h2 = harness({ statuses: [{ status: 413 }, { status: 201 }] });
  h2.device(`${FCM}desk`);
  await h2.final('agent:main:dashboard:a', 'y'.repeat(140));
  assert.equal(h2.sent.length, 2);
  assert.ok(h2.sent[1].payload.body.length <= 60);

  const h3 = harness({ statuses: [{ status: 429, retryAfterMs: 2000 }, { status: 503, retryAfterMs: null }, { status: 201 }] });
  h3.device(`${FCM}desk`);
  h3.final('agent:main:dashboard:a', 'z');
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(h3.sent.length, 1);
  await h3.advance(2000);
  assert.equal(h3.sent.length, 2);
  await h3.advance(2000);
  assert.equal(h3.sent.length, 3);
  assert.equal(h3.store.list().length, 1);

  const h4 = harness({ statuses: [{ status: 401 }, { status: 201 }] });
  h4.device(`${FCM}desk`);
  await h4.final('agent:main:dashboard:a', 'w');
  assert.equal(h4.vapidCalls.length, 2);
  assert.equal(h4.sent.length, 2);
});

test('one approval is one push per device: repeated events, presence flapping, escalation, a restarted connector', async () => {
  const h = harness();
  h.device(`${FCM}desk`);
  h.device(`${APPLE}iphone`, { mobile: true });
  await h.approval('exec.approval.requested', execApproval('ap1'));
  await h.approval('exec.approval.requested', execApproval('ap1')); // the same event again
  for (let i = 0; i < 3; i++) { h.present(true); await h.advance(10_000); h.present(false); await h.advance(10_000); }
  await h.advance(130_000); // past the escalation
  assert.deepEqual(h.sent.filter(s => s.payload.kind === 'approval').map(s => s.endpoint).sort(), [`${FCM}desk`, `${APPLE}iphone`].sort());
  // A restarted connector starts empty and the gateway announces an approval only when it is created
  // (approval-shared.ts): a resolve or presence change for it pushes nothing.
  const restarted = harness();
  restarted.device(`${FCM}desk`);
  await restarted.approval('exec.approval.resolved', { id: 'ap1', decision: 'allow-once' });
  restarted.present(false);
  await restarted.advance(200_000);
  assert.equal(restarted.sent.length, 0);
});

test('no answer from the push service: one retry at most, same Topic, without renotify', async () => {
  const h = harness({ statuses: [{ status: 0 }, { status: 0 }, { status: 201 }] });
  h.device(`${FCM}desk`);
  h.approval('exec.approval.requested', execApproval('ap1'));
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  await h.advance(1000);
  await h.advance(10_000);
  assert.equal(h.sent.length, 2); // the first try and one retry; the third status is never asked for
  assert.equal(h.sent[0].payload.renotify, true);
  assert.equal(h.sent[1].payload.renotify, false);
  assert.equal(h.sent[0].opts.topic, h.sent[1].opts.topic);
  // a 5xx still gets its retries
  const h2 = harness({ statuses: [{ status: 503 }, { status: 503 }, { status: 201 }] });
  h2.device(`${FCM}desk`);
  h2.approval('exec.approval.requested', execApproval('ap2'));
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  await h2.advance(1000); await h2.advance(2000);
  assert.equal(h2.sent.length, 3);
});
