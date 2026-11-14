// Browser FormData -> shim -> upload handler: a repeated key (several files) must keep every file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchRpc } from '../dist/shim.js';
import { handleWorkspaceUpload } from '../server/controllers/filesystem.js';

const file = (name, text) => ({ filename: name, contentType: 'text/plain', data: Buffer.from(text).toString('base64') });

async function upload(fields) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.clawchats-upload-test-'));
  try {
    const res = await dispatchRpc(
      { id: '1', method: 'POST', url: '/api/workspace/upload', body: JSON.stringify({ _multipart: true, fields }) },
      (req, r) => handleWorkspaceUpload(req, r, { path: dir }),
    );
    const names = fs.readdirSync(dir).sort();
    const contents = Object.fromEntries(names.map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
    return { res, names, read: (n) => contents[n] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a repeated key (array) uploads every file', async () => {
  const { res, names, read } = await upload({ files: [file('a.txt', 'AAA'), file('b.txt', 'BBB'), file('c.txt', 'CCC')] });
  assert.equal(res.status, 200);
  assert.deepEqual(names, ['a.txt', 'b.txt', 'c.txt']);
  assert.equal(read('b.txt'), 'BBB');
});

test('a single file (old envelope shape) still works', async () => {
  const { res, names } = await upload({ files: file('only.txt', 'X') });
  assert.equal(res.status, 200);
  assert.deepEqual(names, ['only.txt']);
});
