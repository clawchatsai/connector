import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../bootstrap/native.js';
import { createExtrasStore, cleanPreset } from './extras-store.js';

test('project preset: stored with the style, kept when only color changes, cleared by null, follows rename/delete', () => {
  const db = new Database(':memory:');
  const extras = createExtrasStore(() => db);
  extras.setProjectStyle('Work', { color: 'red' });
  assert.deepEqual(extras.getProjectStyles().Work, { color: 'red', icon: null, preset: null });

  extras.setProjectStyle('Work', { preset: { agentId: 'dev', cwd: '/home/u/repos', permissionMode: 'full', thinkingLevel: 'high', fastMode: false } });
  extras.setProjectStyle('Work', { color: 'blue' });
  assert.deepEqual(extras.getProjectStyles().Work, {
    color: 'blue', icon: null,
    preset: { agentId: 'dev', cwd: '/home/u/repos', permissionMode: 'full', thinkingLevel: 'high', fastMode: false },
  });

  extras.renameProjectStyle('Work', 'Job');
  assert.equal(extras.getProjectStyles().Job.preset.agentId, 'dev');
  extras.setProjectStyle('Job', { preset: null });
  assert.equal(extras.getProjectStyles().Job.preset, null);
  extras.deleteProjectStyle('Job');
  assert.equal(extras.getProjectStyles().Job, undefined);
});

test('project preset: adds the column to an existing table', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE project_styles (name TEXT PRIMARY KEY, color TEXT, icon TEXT, updated_at INTEGER NOT NULL)');
  db.prepare('INSERT INTO project_styles VALUES (?, ?, ?, ?)').run('Old', 'green', null, 1);
  const extras = createExtrasStore(() => db);
  assert.deepEqual(extras.getProjectStyles().Old, { color: 'green', icon: null, preset: null });
  extras.setProjectStyle('Old', { preset: { model: 'anthropic/claude-opus-5-5' } });
  assert.deepEqual(extras.getProjectStyles().Old.preset, { model: 'anthropic/claude-opus-5-5' });
});

test('cleanPreset: known fields only, valid permission mode, projectId wins over cwd', () => {
  assert.equal(cleanPreset(null), null);
  assert.equal(cleanPreset({}), null);
  assert.equal(cleanPreset({ junk: 'x', agentId: '  ' }), null);
  assert.deepEqual(cleanPreset({ permissionMode: 'yolo', agentId: 'dev' }), { agentId: 'dev' });
  assert.deepEqual(cleanPreset({ cwd: '/a', projectId: 'p1', projectLabel: 'Repo' }), { projectId: 'p1', projectLabel: 'Repo' });
  assert.deepEqual(cleanPreset({ cwd: '/a', projectLabel: 'Repo' }), { cwd: '/a' });
  assert.deepEqual(cleanPreset({ fastMode: true }), { fastMode: true });
});

test('bookmarks: add is idempotent per message, rename, delete, dropped with the session', () => {
  const db = new Database(':memory:');
  const extras = createExtrasStore(() => db);
  const a = extras.addBookmark('b1', { sessionKey: 'agent:main:x', messageId: 'm1', role: 'assistant', label: '  Plan  ', snippet: 'The plan…', chatTitle: 'Chat X' });
  assert.equal(a.label, 'Plan');
  assert.equal(a.chatTitle, 'Chat X');
  // Same message again: the existing bookmark comes back unchanged.
  const again = extras.addBookmark('b2', { sessionKey: 'agent:main:x', messageId: 'm1', label: 'Other' });
  assert.equal(again.id, 'b1');
  assert.equal(again.label, 'Plan');
  assert.equal(extras.addBookmark('b3', { sessionKey: 'agent:main:x' }), null);
  extras.addBookmark('b4', { sessionKey: 'agent:main:y', messageId: 'm9', role: 'user', label: '', snippet: 'hi' });
  assert.deepEqual(extras.listBookmarks().map(b => [b.id, b.label]).sort(), [['b1', 'Plan'], ['b4', 'Bookmark']]);

  assert.equal(extras.renameBookmark('b1', 'Bulk export plan').label, 'Bulk export plan');
  assert.equal(extras.renameBookmark('b1', '   '), null);
  assert.equal(extras.renameBookmark('nope', 'x'), null);

  assert.equal(extras.deleteBookmark('b4'), true);
  assert.equal(extras.deleteBookmark('b4'), false);
  extras.deleteThreadExtras('agent:main:x');
  assert.deepEqual(extras.listBookmarks(), []);
});
