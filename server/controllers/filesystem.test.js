import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleWorkspaceFileRead } from './filesystem.js';

function read(filePath, workspaceDir) {
  const out = { status: 0, body: '' };
  const res = {
    writeHead(status) { out.status = status; },
    setHeader() {},
    end(body) { out.body = String(body ?? ''); },
  };
  handleWorkspaceFileRead({}, res, { path: filePath }, workspaceDir);
  return out;
}

test('file reads: any absolute path, ~ is home, relative paths resolve against the workspace', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-read-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ws-'));
  fs.writeFileSync(path.join(outside, 'a.md'), 'outside');
  fs.mkdirSync(path.join(workspace, 'notes'));
  fs.writeFileSync(path.join(workspace, 'notes', 'b.md'), 'relative');
  try {
    assert.deepEqual(read(path.join(outside, 'a.md'), workspace), { status: 200, body: 'outside' });
    assert.deepEqual(read('notes/b.md', workspace), { status: 200, body: 'relative' });
    assert.deepEqual(read('./notes/b.md', workspace), { status: 200, body: 'relative' });
    assert.equal(read('notes/missing.md', workspace).status, 404);
    assert.equal(read('notes', workspace).status, 404);
    // `~` only expands as the home segment; "~x" is an ordinary relative name.
    assert.equal(read('~x/b.md', workspace).status, 404);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('file reads: ~/ expands to home', () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.cc-read-test-'));
  fs.writeFileSync(path.join(dir, 'c.txt'), 'home');
  try {
    const rel = '~/' + path.relative(os.homedir(), path.join(dir, 'c.txt'));
    assert.deepEqual(read(rel, '/nonexistent-workspace'), { status: 200, body: 'home' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
