import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createTitleHandler, normalizeTitle, TITLE_PROMPT } from './title.js';

function call(handler, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  return new Promise((resolve, reject) => {
    const res = { writeHead(status) { this.status = status; }, end(data) { resolve({ status: this.status, body: JSON.parse(data) }); } };
    handler(req, res).catch(reject);
  });
}

test('normalizeTitle: first line, no label/quotes, max 60 chars', () => {
  assert.equal(normalizeTitle('Title: "Fix sidebar flicker"\nmore'), 'Fix sidebar flicker');
  assert.equal(normalizeTitle('```\n'), null);
  assert.equal(normalizeTitle('x'.repeat(80)).length, 60);
});

test('direct completion with the gateway title prompt', async () => {
  const calls = [];
  const handler = createTitleHandler({ complete: async p => { calls.push(p); return { text: 'Fix sidebar flicker', provider: 'anthropic', model: 'claude-haiku-4-5' }; } });
  const r = await call(handler, { message: 'User: the sidebar flickers' });
  assert.deepEqual(r, { status: 200, body: { title: 'Fix sidebar flicker', model: 'anthropic/claude-haiku-4-5' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].systemPrompt, TITLE_PROMPT);
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'User: the sidebar flickers' }]);
  assert.equal(calls[0].execution, undefined);
});

test('falls back to isolated agent-runtime mode when direct completion fails (CLI runtimes)', async () => {
  const calls = [];
  const handler = createTitleHandler({ complete: async p => { calls.push(p); if (!p.execution) throw Object.assign(new Error('no transport'), { code: 'LLM_COMPLETION_FAILED' }); return { text: 'Proxmox backups' }; } });
  const r = await call(handler, { message: 'hi there' });
  assert.equal(r.body.title, 'Proxmox backups');
  assert.equal(calls[1].execution.mode, 'isolated-agent-runtime');
});

test('authorization failures are not retried; bad input is rejected', async () => {
  let n = 0;
  const handler = createTitleHandler({ complete: async () => { n++; throw Object.assign(new Error('denied'), { code: 'LLM_COMPLETION_NOT_AUTHORIZED' }); } });
  await assert.rejects(call(handler, { message: 'x' }), /denied/);
  assert.equal(n, 1);
  assert.equal((await call(handler, { message: '  ' })).status, 400);
  assert.equal((await call(createTitleHandler(undefined), { message: 'x' })).status, 501);
});
