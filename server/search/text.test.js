import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentsOf, parseSelectionComment, commentAttachments } from './text.js';

const meta = (id, extra = {}) => ({ __openclaw: { id, ...extra } });

function commentBody({ text, comment = '', key = 'agent:main:dashboard:a' }) {
  // Same as frontend/chat/selection-comments.js formatSelectionComment.
  return [`Selected text:\n${text}`, ...(comment.trim() ? [`User comment:\n${comment}`] : []),
    [`Source session: ${key}`, 'Source message: m1', `Selected text UTF-16 length: ${text.length}`, 'DOM text UTF-16 range: [0, 4)'].join('\n')].join('\n\n');
}

test('user and assistant text; tool calls, thinking and directives stay out', () => {
  assert.deepEqual(documentsOf({ role: 'user', content: 'deploy the connector', timestamp: 5, ...meta('u1') }),
    { id: 'u1', ts: 5, truncated: false, docs: [{ kind: 'message', role: 'user', text: 'deploy the connector' }], comments: [] });
  const a = documentsOf({ role: 'assistant', timestamp: '2026-11-20T02:39:32.509Z', ...meta('a1'), content: [
    { type: 'thinking', thinking: 'secret plan' }, { type: 'toolcall', name: 'Bash' }, { type: 'text', text: '[[reply_to_current]] Done, it works.' }] });
  assert.equal(a.docs[0].text, 'Done, it works.');
  assert.equal(a.ts, Date.parse('2026-11-20T02:39:32.509Z'));
  assert.equal(documentsOf({ role: 'toolResult', content: 'output', ...meta('t1') }), null);
  assert.equal(documentsOf({ role: 'assistant', content: [{ type: 'toolcall' }], ...meta('a2') }), null, 'nothing searchable');
  assert.equal(documentsOf({ role: 'user', content: 'no id' }), null);
});

test('a truncated entry is reported so the indexer fetches it whole', () => {
  const e = documentsOf({ role: 'assistant', content: [{ type: 'text', text: 'long…' }], ...meta('a1', { truncated: true, reason: 'display-cap' }) });
  assert.equal(e.truncated, true);
});

test('selection comments: attachments listed, body parsed by its declared length', () => {
  const m = { role: 'user', content: '', ...meta('u1', { media: [
    { url: 'media://inbound/selection-comment---1.txt', fileName: 'selection-comment.txt', contentType: 'text/plain' },
    { url: 'media://inbound/photo.png', fileName: 'photo.png', kind: 'image' },
    { url: 'https://evil/x', fileName: 'selection-comment.txt' }] }) };
  assert.deepEqual(commentAttachments(m), [{ url: 'media://inbound/selection-comment---1.txt' }]);
  const e = documentsOf(m);
  assert.deepEqual(e.docs, []);
  assert.equal(e.comments.length, 1);

  assert.deepEqual(parseSelectionComment(commentBody({ text: 'Plan\n\nBuild 1', comment: 'work this plan' })), { quote: 'Plan\n\nBuild 1', comment: 'work this plan' });
  // A passage that itself contains the comment marker is cut by length, not by marker.
  const tricky = 'a\n\nUser comment:\nnot a comment';
  assert.deepEqual(parseSelectionComment(commentBody({ text: tricky, comment: 'real' })), { quote: tricky, comment: 'real' });
  assert.deepEqual(parseSelectionComment(commentBody({ text: 'just a quote' })), { quote: 'just a quote', comment: '' });
  assert.equal(parseSelectionComment('random text file'), null);
  assert.equal(parseSelectionComment(null), null);
});

test('team rooms: author map decides the role, label prefix and timeline lines go', () => {
  const team = { e1: { type: 'user' }, e2: { type: 'person', name: 'Kamil' }, e3: { type: 'agent', agentId: 'main' }, e4: { type: 'system' } };
  const entry = (id, text) => ({ role: 'assistant', content: [{ type: 'text', text }], ...meta(id) });
  assert.deepEqual(documentsOf(entry('e1', '[Houman]\n\nship it'), { team }).docs, [{ kind: 'message', role: 'user', text: 'ship it' }]);
  assert.equal(documentsOf(entry('e2', '[Kamil]\n\nhello'), { team }).docs[0].role, 'person');
  assert.equal(documentsOf(entry('e3', '[homiabot]\n\non it'), { team }).docs[0].role, 'assistant');
  assert.equal(documentsOf(entry('e4', '[System]\n\nKamil joined'), { team }), null);
  assert.equal(documentsOf(entry('e9', '[System]\n\nold host line'), { team }), null, 'unknown System line');
});
