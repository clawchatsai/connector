import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleWorkspaceFileRead, handleWorkspaceCreate } from './filesystem.js';

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

function create(query) {
  const out = { status: 0, body: null };
  const res = {
    writeHead(status) { out.status = status; },
    setHeader() {},
    end(body) { out.body = JSON.parse(String(body ?? 'null')); },
  };
  handleWorkspaceCreate({}, res, query);
  return out;
}

test('create: makes an empty file or folder inside home, rejects bad names and existing entries', () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.cc-create-test-'));
  const tilde = '~/' + path.relative(os.homedir(), dir);
  try {
    assert.equal(create({ path: tilde, name: 'sub', type: 'dir' }).status, 200);
    assert.ok(fs.statSync(path.join(dir, 'sub')).isDirectory());
    const file = create({ path: path.join(dir, 'sub'), name: 'a.md', type: 'file' });
    assert.equal(file.status, 200);
    assert.equal(file.body.path, path.join(dir, 'sub', 'a.md'));
    assert.equal(fs.readFileSync(path.join(dir, 'sub', 'a.md'), 'utf8'), '');
    assert.equal(create({ path: dir, name: 'sub', type: 'dir' }).status, 409);
    assert.equal(create({ path: dir, name: 'sub', type: 'file' }).status, 409);
    for (const name of ['..', '.', 'a/b', 'a\\b', ' x', '']) {
      assert.notEqual(create({ path: dir, name, type: 'dir' }).status, 200, name);
    }
    assert.equal(create({ path: dir, name: 'x', type: 'link' }).status, 400);
    assert.equal(create({ path: path.join(dir, 'missing'), name: 'x', type: 'dir' }).status, 404);
    assert.equal(create({ path: '/tmp', name: 'cc-x', type: 'dir' }).status, 403);
    assert.equal(create({ path: os.homedir() + '-sibling', name: 'x', type: 'dir' }).status, 403);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
