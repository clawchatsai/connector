import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactFrame } from './debug.js';

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
