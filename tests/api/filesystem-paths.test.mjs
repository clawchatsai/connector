import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { isPathWithin } from '../../server/controllers/filesystem.js';

test('accepts the home directory and its descendants', () => {
  const home = path.resolve('/home/alice');

  assert.equal(isPathWithin(home, home), true);
  assert.equal(isPathWithin(home, path.join(home, 'workspace', 'file.txt')), true);
});

test('rejects sibling paths that share the home prefix', () => {
  const home = path.resolve('/home/alice');

  assert.equal(isPathWithin(home, path.resolve('/home/alice-backup')), false);
  assert.equal(isPathWithin(home, path.resolve('/home/bob')), false);
});

test('rejects paths that traverse above the home directory', () => {
  const home = path.resolve('/home/alice');

  assert.equal(isPathWithin(home, path.resolve(home, '..', 'secret.txt')), false);
});
