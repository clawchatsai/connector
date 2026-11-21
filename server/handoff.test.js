import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serveOnce, sweep, handoffTool, auditLog, NAME_RE, TTL_MS } from './handoff.js';
import { copyTools, defaultContact, ALWAYS_OFF } from './peer/contact-policy.js';

const run = promisify(execFile);
const linux = process.platform === 'linux';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
const SECRET = 'hunter2-not-real';
const done = () => { let r; const p = new Promise(res => { r = res; }); return { p, r }; };

test('serves the value once, then the pipe is gone and the buffer zeroed', { skip: !linux }, async () => {
  const root = tmp(), buf = Buffer.from(SECRET), d = done();
  const { fifo, expiresAtMs } = serveOnce(buf, { root, onDone: d.r });
  assert.equal(fs.statSync(fifo).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(fifo)).mode & 0o777, 0o700);
  assert.ok(expiresAtMs > Date.now() + TTL_MS - 5000);
  const { stdout } = await run('sh', ['-c', `wc -c < ${fifo}`]);
  assert.equal(stdout.trim(), String(SECRET.length));
  const info = await d.p;
  assert.equal(info.outcome, 'read');
  assert.equal(info.bytes, SECRET.length);
  assert.ok(info.openers.some(o => /wc -c/.test(o.parent) || /sh -c/.test(o.cmd)), JSON.stringify(info.openers));
  assert.ok(buf.every(b => b === 0));
  assert.equal(fs.existsSync(fifo), false);
  await assert.rejects(run('sh', ['-c', `cat < ${fifo}`]));
  fs.rmSync(root, { recursive: true });
});

test('an unread pipe expires', { skip: !linux }, async () => {
  const root = tmp(), buf = Buffer.from(SECRET), d = done();
  const { fifo } = serveOnce(buf, { root, ttlMs: 120, onDone: d.r });
  assert.equal((await d.p).outcome, 'expired');
  assert.equal(fs.existsSync(fifo), false);
  assert.equal(fs.existsSync(path.dirname(fifo)), false);
  assert.ok(buf.every(b => b === 0));
  fs.rmSync(root, { recursive: true });
});

test('sweep removes only pipes older than the TTL', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'h-old')); fs.mkdirSync(path.join(root, 'h-new')); fs.mkdirSync(path.join(root, 'other'));
  const old = (Date.now() - TTL_MS - 60_000) / 1000;
  fs.utimesSync(path.join(root, 'h-old'), old, old);
  assert.equal(sweep(root), 1);
  assert.deepEqual(fs.readdirSync(root).sort(), ['h-new', 'other']);
  fs.rmSync(root, { recursive: true });
});

const tool = (over = {}) => {
  const events = [], resolved = [];
  const t = handoffTool({
    resolve: async refs => { resolved.push(...refs); return new Map(refs.map(r => [r.id, r.id === 'HANDOFF_GONE' ? undefined : SECRET])); },
    audit: e => events.push(e),
    serve: (buf, { onDone }) => { setImmediate(() => { buf.fill(0); onDone({ fifo: '/run/x/fifo', outcome: 'read', bytes: 1, openers: [] }); }); return { fifo: '/run/x/fifo', expiresAtMs: 0 }; },
    ...over,
  });
  return { t, events, resolved };
};

test('offered only on the owner\'s own unsandboxed turns', () => {
  const { t } = tool();
  assert.equal(t.contextVersion, 2);
  assert.equal(t.create({ senderIsOwner: false }), null); // contact copies, guests, other people on channels
  assert.equal(t.create({}), null); // a host that doesn't say (owner bit missing)
  assert.equal(t.create({ senderIsOwner: true, sandboxed: true }), null);
  assert.equal(t.create({ senderIsOwner: true, sandbox: { run() {} } }), null);
  const made = t.create({ senderIsOwner: true });
  assert.equal(made.name, 'handoff');
  assert.equal(made.catalogMode, 'direct-only');
  assert.match(made.description, /secrets delete/);
  assert.match(made.description, /HANDOFF_/);
  assert.match(made.description.split('. ')[0], /^Password typed into a command on this machine/, 'the first line decides which mechanism: deferred catalogs show only it');
});

test('serves only HANDOFF_* entries: web keys never resolve', async () => {
  const { t, resolved, events } = tool();
  const x = t.create({ senderIsOwner: true });
  for (const name of ['OPENAI_API_KEY', 'HANDOFF_', 'handoff_x', 'HANDOFF_X;rm', '']) {
    const r = await x.execute('1', { name, reason: 'r' });
    assert.equal(r.details.status, 'refused', name);
  }
  assert.equal(resolved.length, 0);
  assert.ok(events.every(e => e.ev === 'refused'));
  assert.ok(NAME_RE.test('HANDOFF_VAULTWARDEN_BOT'));
});

test('a ready pipe; the value never reaches the result or the audit log', async () => {
  const root = tmp(), file = path.join(root, 'clawchats', 'handoff-audit.log');
  const { t, resolved } = tool({ audit: auditLog(file) });
  let checked = 0;
  const x = t.create({ senderIsOwner: true, sessionKey: 'agent:main:dashboard:a', config: { secrets: { defaults: { store: 'team' } } }, assertInvocationCurrent: () => { checked++; } });
  const r = await x.execute('1', { name: 'HANDOFF_VAULT', reason: 'bw unlock --passwordfile' });
  assert.equal(r.details.status, 'ready');
  assert.equal(r.details.usage, 'cmd < /run/x/fifo');
  assert.match(r.details.then, /secrets delete HANDOFF_VAULT/);
  assert.deepEqual(resolved[0], { source: 'store', provider: 'team', id: 'HANDOFF_VAULT' });
  assert.equal(checked, 1);
  await new Promise(r => setImmediate(r));
  const log = fs.readFileSync(file, 'utf8');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const lines = log.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.ev), ['requested', 'delivered']);
  assert.equal(lines[1].reason, undefined, 'the pipe outcome is the event, not a second reason');
  assert.ok(!log.includes(SECRET) && !JSON.stringify(r).includes(SECRET));
  const gone = await x.execute('2', { name: 'HANDOFF_GONE', reason: 'r' });
  assert.equal(gone.details.status, 'missing');
  assert.match(gone.details.next, /action: "request", name: "HANDOFF_GONE", allowedHosts: \[\]/);
  assert.match(gone.details.next, /dispatch_action/);
  assert.match(gone.details.next, /Never ask for the value in chat/);
  const thrown = await tool({ resolve: async () => { throw new Error(`boom ${SECRET}`); } }).t.create({ senderIsOwner: true }).execute('3', { name: 'HANDOFF_X', reason: 'r' });
  assert.equal(thrown.details.status, 'missing');
  assert.ok(!JSON.stringify(thrown).includes(SECRET));
  fs.rmSync(root, { recursive: true });
});

test('every contact copy denies handoff, whatever its card allows', () => {
  assert.ok(ALWAYS_OFF.includes('handoff'));
  for (const access of ['restricted', 'trusted', 'full']) for (const commands of ['off', 'basic', 'ask', 'auto']) {
    const c = { ...defaultContact(access), commands, tools: ['handoff', 'secrets', 'exec', 'read', 'web_fetch'] };
    const t = copyTools(c);
    assert.ok(t.deny.includes('handoff'), `${access}/${commands}`);
    assert.ok(!t.alsoAllow.includes('handoff'), `${access}/${commands}`);
  }
});
