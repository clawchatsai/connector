// Chunked browser messages (src/chunk-reassembly.ts): every field checked, memory bounded.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkReassembler, MAX_CHUNKS, MAX_CHUNK_DATA_LENGTH } from '../dist/chunk-reassembly.js';

afterEach(() => mock.timers.reset());

const chunk = (index, total, data = 'x', id = 'm1') => ({ type: 'rpc-chunk-req', id, index, total, data });

test('reassembles in any order, ignores duplicates', () => {
  const r = new ChunkReassembler();
  assert.equal(r.add('c1', chunk(2, 3, 'C')), null);
  assert.equal(r.add('c1', chunk(0, 3, 'A')), null);
  assert.equal(r.add('c1', chunk(0, 3, 'Z')), null); // duplicate: first wins
  assert.deepEqual(r.add('c1', chunk(1, 3, 'B')), { done: 'ABC' });
  assert.equal(r.bufferedLength, 0);
});

test('bad fields are rejected without allocating', () => {
  const r = new ChunkReassembler();
  const bad = [
    { index: 0, total: 1, data: 'x' }, // no id
    { id: 7, index: 0, total: 1, data: 'x' },
    { id: 'i'.repeat(257), index: 0, total: 1, data: 'x' },
    chunk(0, 0), chunk(0, -1), chunk(0, 1.5), chunk(0, '2'), chunk(0, NaN), chunk(0, MAX_CHUNKS + 1), chunk(0, 1e9),
    chunk(-1, 2), chunk(2, 2), chunk(0.5, 2), chunk('0', 2), chunk(null, 2),
    chunk(0, 2, ''), chunk(0, 2, 42), chunk(0, 2, { length: 1 }), chunk(0, 2, 'y'.repeat(MAX_CHUNK_DATA_LENGTH + 1)),
  ];
  for (const m of bad) assert.ok('error' in (r.add('c1', m) ?? {}), JSON.stringify(m).slice(0, 80));
  assert.equal(r.bufferedLength, 0);
});

test('a changed total, an oversized message or too much buffered data drops the message', () => {
  const r = new ChunkReassembler({ message: 10, buffered: 15 });
  r.add('c1', chunk(0, 3, 'aaaa'));
  assert.deepEqual(r.add('c1', chunk(1, 4, 'b')), { error: 'total changed' });
  assert.equal(r.bufferedLength, 0);

  r.add('c1', chunk(0, 3, 'aaaaaa'));
  assert.deepEqual(r.add('c1', chunk(1, 3, 'bbbbb')), { error: 'message too large' });
  assert.equal(r.bufferedLength, 0);

  r.add('c1', chunk(0, 2, 'aaaaaaaa', 'm1'));
  assert.deepEqual(r.add('c1', chunk(0, 2, 'bbbbbbbb', 'm2')), { error: 'too much data in progress' });
  assert.equal(r.bufferedLength, 8);
});

test('connections cannot touch each other\'s messages; a closed connection is forgotten', () => {
  const r = new ChunkReassembler();
  r.add('c1', chunk(0, 2, 'A'));
  assert.equal(r.add('c2', chunk(1, 2, 'X')), null);
  assert.deepEqual(r.add('c1', chunk(1, 2, 'B')), { done: 'AB' });
  r.dropConnection('c2');
  assert.equal(r.bufferedLength, 0);
});

test('incomplete messages are dropped after 30 s', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const r = new ChunkReassembler();
  r.add('c1', chunk(0, 2, 'A'));
  mock.timers.tick(30_000);
  assert.equal(r.bufferedLength, 0);
  assert.equal(r.add('c1', chunk(1, 2, 'B')), null, 'starts over');
});
