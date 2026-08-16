// Ad-hoc measurement for CLA-1419: what the cross-workspace uploads guard costs a
// DELETE /api/threads/:id. Not part of the suite — run it directly:
//   node tests/bench-delete-guard.mjs
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/harness.mjs';

const THREADS_PER_WORKSPACE = 500;
const DELETES = 200;

function seed(db, prefix, n) {
  const insert = db.prepare('INSERT INTO threads (id, session_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const now = Date.now();
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) insert.run(`${prefix}-${i}`, `agent:main:x:chat:${prefix}-${i}`, 't', now, now);
  db.exec('COMMIT');
}

async function measure(workspaceCount) {
  const srv = await startTestServer();
  const names = ['default'];
  for (let i = 1; i < workspaceCount; i++) {
    const name = `ws${i}`;
    const created = await srv.api('POST', '/api/workspaces', { body: { name } });
    assert.equal(created.status, 201);
    names.push(name);
  }
  for (const name of names) seed(srv.app.getDb(name), `${name}-t`, THREADS_PER_WORKSPACE);

  // Extra victims in "default" for the delete loop below.
  seed(srv.app.getDb('default'), 'victim', DELETES);

  // Cold: the first delete after boot is the one that may have to open and migrate
  // every workspace database that no request has touched yet.
  const coldSrv = await startTestServer();
  for (let i = 1; i < workspaceCount; i++) await coldSrv.api('POST', '/api/workspaces', { body: { name: `ws${i}` } });
  await coldSrv.api('POST', '/api/threads', { body: { id: 'cold-victim' } });
  coldSrv.app.shutdown();               // drop every cached handle
  await coldSrv.api('POST', '/api/threads', { body: { id: 'cold-warmup' } }); // reopen "default" only
  const coldStart = process.hrtime.bigint();
  await coldSrv.api('DELETE', '/api/threads/cold-victim');
  const cold = Number(process.hrtime.bigint() - coldStart) / 1e6;
  await coldSrv.close();

  // Warm: every handle cached, which is the steady state after the first request
  // that touches each workspace.
  const samples = [];
  for (let i = 0; i < DELETES; i++) {
    const start = process.hrtime.bigint();
    const res = await srv.api('DELETE', `/api/threads/victim-${i}`);
    assert.equal(res.status, 200);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  await srv.close();
  return {
    workspaces: workspaceCount,
    cold_ms: +cold.toFixed(3),
    p50_ms: +samples[Math.floor(samples.length * 0.5)].toFixed(3),
    p95_ms: +samples[Math.floor(samples.length * 0.95)].toFixed(3),
  };
}

const rows = [];
for (const n of [1, 5, 10, 25, 50]) rows.push(await measure(n));
console.table(rows);
