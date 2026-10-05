import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleWorkspaceFileRead, handleWorkspaceCreate, resolveReadPath } from './filesystem.js';

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

test('resolveReadPath: session root before workspace, then a unique match under a hint ancestor', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-resolve-'));
  const mk = (rel, body = rel) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  const inSession = mk('session/src/a.ts');
  mk('ws/src/a.ts');
  const inRepo = mk('repos/up/ui/src/pages/p.ts');
  mk('repos/up/ui/src/pages/deep/x.md');
  mk('one/lib/dup.ts');
  mk('two/lib/dup.ts');
  const roots = [path.join(base, 'session'), path.join(base, 'ws')];
  try {
    assert.equal(resolveReadPath('src/a.ts', { roots }), inSession);
    assert.equal(resolveReadPath('src/a.ts', { roots: [null, path.join(base, 'ws')] }), path.join(base, 'ws/src/a.ts'));
    assert.equal(resolveReadPath(inRepo, { roots }), inRepo);
    assert.equal(resolveReadPath('ui/src/pages/p.ts', { roots }), null);
    // The agent `cd`'d deep into the repo; the repo root is an ancestor of the hint.
    assert.equal(resolveReadPath('ui/src/pages/p.ts', { roots, hints: [path.join(base, 'repos/up/ui/src/pages/deep')] }), inRepo);
    // Two different files match: ambiguous, not found.
    assert.equal(resolveReadPath('lib/dup.ts', { roots, hints: [path.join(base, 'one/lib'), path.join(base, 'two')] }), null);
    // Relative hints are ignored.
    assert.equal(resolveReadPath('ui/src/pages/p.ts', { roots, hints: ['repos/up'] }), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveReadPath: a hint into a removed worktree finds the file in the main checkout', () => {
  // Searches stay inside HOME, so this layout lives there.
  const base = fs.mkdtempSync(path.join(os.homedir(), '.cc-gone-'));
  const mk = (rel, body = rel) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  fs.mkdirSync(path.join(base, 'repos/app/.git'), { recursive: true });
  const main = mk('repos/app/known-gaps/q.md');
  // Another chat's live worktree of the same repo has a copy (linked worktree: `.git` is a file).
  mk('repos/worktrees/app-other/.git', 'gitdir: elsewhere');
  mk('repos/worktrees/app-other/known-gaps/q.md');
  const gone = path.join(base, 'repos/worktrees/app-queue/frontend');
  try {
    assert.equal(resolveReadPath('known-gaps/q.md', { hints: [gone] }), main);
    // Two main checkouts with the file: ambiguous.
    fs.mkdirSync(path.join(base, 'repos/fork/.git'), { recursive: true });
    mk('repos/fork/known-gaps/q.md');
    assert.equal(resolveReadPath('known-gaps/q.md', { hints: [gone] }), null);
    // Hints that still exist never trigger the search.
    assert.equal(resolveReadPath('known-gaps/q.md', { hints: [path.join(base, 'repos/worktrees')] }), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveReadPath: several hint matches prefer the git main checkout', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tie-'));
  const mk = (rel, body = rel) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  fs.mkdirSync(path.join(base, 'app/.git'), { recursive: true });
  const main = mk('app/src/a.js');
  mk('wt/.git', 'gitdir: elsewhere');
  mk('wt/src/a.js');
  try {
    assert.equal(resolveReadPath('src/a.js', { hints: [path.join(base, 'app/lib'), path.join(base, 'wt/lib')] }), main);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('file reads: stat=1 answers the resolved path and size; hints arrive newline-separated', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-stat-'));
  const f = path.join(base, 'repo/docs/n.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'hello');
  const out = { status: 0, body: '' };
  const res = { writeHead(s) { out.status = s; }, setHeader() {}, end(b) { out.body = String(b ?? ''); } };
  try {
    handleWorkspaceFileRead({}, res, { path: 'docs/n.md', stat: '1', hints: `/nonexistent\n${path.join(base, 'repo/docs')}` }, '/nonexistent-ws');
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.body), { path: f, size: 5 });
    handleWorkspaceFileRead({}, res, { path: 'docs/gone.md', stat: '1' }, base, path.join(base, 'repo'));
    assert.equal(out.status, 404);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
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
