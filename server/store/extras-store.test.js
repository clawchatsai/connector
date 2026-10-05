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
