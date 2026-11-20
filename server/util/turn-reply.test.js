import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptIndex, replyAfter } from './turn-reply.js';

const prompt = { role: 'user', content: 'write it', __openclaw: { idempotencyKey: 'r1:user' } };
const said = (text, stopReason) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason });
const cont = { role: 'user', content: 'A plugin was reloaded; continue', provenance: { kind: 'internal_system' } };
const tool = { role: 'toolResult', content: [{ type: 'text', text: '(no output)' }] };

test('the prompt is found by its idempotency key', () => {
  assert.equal(promptIndex([{ role: 'user', content: 'older' }, prompt], 'r1'), 1);
  assert.equal(promptIndex([prompt], 'r2'), -1);
});

test('a handover extra step after the final reply: the reply is the one that ended the turn', () => {
  const msgs = [prompt, said('working on it', 'toolUse'), tool, said('the essay', 'stop'), cont, said('The plugin reload is noted. I have completed the task.', 'stop')];
  assert.equal(replyAfter(msgs, 0).content[0].text, 'the essay');
});

test('a run a restart cut off: the reply after the continue counts', () => {
  const msgs = [prompt, said('half of it', 'toolUse'), cont, said('the whole essay', 'stop')];
  assert.equal(replyAfter(msgs, 0).content[0].text, 'the whole essay');
});

test('no stopReason (older transcripts): the last text, never past the next real prompt', () => {
  const msgs = [prompt, said('first'), said('second'), { role: 'user', content: 'next' }, said('other turn', 'stop')];
  assert.equal(replyAfter(msgs, 0).content[0].text, 'second');
  assert.equal(replyAfter([prompt], 0), null);
});
