import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retireFirstRun } from './copy-workspace.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));

test('retireFirstRun: removes the BOOTSTRAP.md file, nothing else', () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, 'BOOTSTRAP.md'), '# Birth Sequence');
  fs.writeFileSync(path.join(ws, 'SOUL.md'), 'be kind');
  assert.equal(retireFirstRun(ws), true);
  assert.deepEqual(fs.readdirSync(ws), ['SOUL.md']);
  assert.equal(retireFirstRun(ws), false, 'already gone: nothing to do');
});

test('retireFirstRun: leaves a link, a folder, a relative or missing path alone, and never throws', () => {
  const ws = tmp();
  const target = path.join(tmp(), 'elsewhere.md');
  fs.writeFileSync(target, 'not ours');
  fs.symlinkSync(target, path.join(ws, 'BOOTSTRAP.md'));
  assert.equal(retireFirstRun(ws), false);
  assert.equal(fs.lstatSync(path.join(ws, 'BOOTSTRAP.md')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'not ours');

  const dirWs = tmp();
  fs.mkdirSync(path.join(dirWs, 'BOOTSTRAP.md'));
  assert.equal(retireFirstRun(dirWs), false);
  assert.ok(fs.existsSync(path.join(dirWs, 'BOOTSTRAP.md')));

  assert.equal(retireFirstRun('relative/ws'), false);
  assert.equal(retireFirstRun(path.join(ws, 'no-such-folder')), false);
  assert.equal(retireFirstRun(undefined), false);
});
