import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactFrame, DebugLogger } from './debug.js';

test('question.resolve answers are masked in debug logs', () => {
  const frame = JSON.stringify({ type: 'req', id: '1', method: 'question.resolve', params: { id: 'q', answers: { answers: { api_key: ['sk-live-SECRET'], other: ['a', 'b'] } }, secretStoreAllowedHosts: ['api.example.com'] } });
  const out = redactFrame(frame);
  assert.ok(!out.includes('sk-live-SECRET'));
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.params.answers.answers, { api_key: ['[redacted]'], other: ['[redacted]', '[redacted]'] });
  assert.equal(parsed.params.id, 'q');
  assert.deepEqual(parsed.params.secretStoreAllowedHosts, ['api.example.com']);
});

test('other frames pass through untouched; unparseable question.resolve frames are dropped', () => {
  const chat = JSON.stringify({ type: 'req', method: 'chat.send', params: { message: 'hi' } });
  assert.equal(redactFrame(chat), chat);
  assert.equal(redactFrame('{"type":"event"}'), '{"type":"event"}');
  assert.ok(!redactFrame('question.resolve {not json secret').includes('secret'));
  const cancel = JSON.stringify({ type: 'req', method: 'question.resolve', params: { id: 'q', cancel: true } });
  assert.equal(redactFrame(cancel), cancel);
});

test('debug-start: the session id can never be a path', async (t) => {
  t.mock.method(console, 'log', () => {});
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-debug-')) + '/data';
  for (const ts of ['../../../../tmp/evil', '/etc/cron.d/x', 'a/b', 'a\\b', 'x\0y', '', 'z'.repeat(200), undefined, 42, { a: 1 }]) {
    const d = new DebugLogger(data);
    const r = d.start(ts, {});
    assert.match(r.sessionId, /^[A-Za-z0-9_-]{1,64}$/, String(ts));
    d.handleClientDisconnect({}); // closes nothing (other client)
    d.saveDump({});
  }
  const d = new DebugLogger(data);
  assert.equal(d.start('2026-10-28T20:48:00.000Z', {}).sessionId, '2026-10-28T20-48-00-000Z');
  d.saveDump({});
  await new Promise(r => setTimeout(r, 100)); // write streams open asynchronously
  const files = fs.readdirSync(path.join(data, '..', 'debug'));
  assert.ok(files.every(f => /^session-[A-Za-z0-9_-]+-ws\.log$/.test(f)), files.join(','));
  fs.rmSync(path.dirname(data), { recursive: true, force: true });
});
