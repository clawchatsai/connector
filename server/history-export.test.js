import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { exportHistory } from './history-export.js';

const KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-export-'));
  const dataDir = path.join(dir, 'data'), stateDir = path.join(dir, 'state');
  fs.mkdirSync(dataDir); fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(dataDir, 'workspaces.json'), JSON.stringify({ workspaces: { p: { name: 'proj', label: 'Proj', order: 1 } } }));
  const db = new DatabaseSync(path.join(dataDir, 'proj.db'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, session_key TEXT); CREATE TABLE messages (thread_id TEXT, role TEXT, content TEXT, timestamp INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('t1', 'Env check', 'agent:main:proj:chat:t1');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('t2', 'Already there', 'agent:main:proj:chat:t2');
  const msg = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)');
  msg.run('t1', 'user', 'what is in the .env?', 1000);
  msg.run('t1', 'assistant', `It has ANTHROPIC_API_KEY=${KEY} and PORT=3000. The password policy is documented.`, 2000);
  msg.run('t2', 'user', 'hi', 1000);
  db.close();
  let connect = null;
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' } }));
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.method === 'connect') { connect = m.params; return ws.send(JSON.stringify({ type: 'res', id: m.id, ok: true, payload: { type: 'hello-ok' } })); }
      if (m.method === 'sessions.list') return ws.send(JSON.stringify({ type: 'res', id: m.id, ok: true, payload: { sessions: [{ key: 'agent:main:proj:chat:t2' }], hasMore: false, nextOffset: null } }));
      ws.send(JSON.stringify({ type: 'res', id: m.id, ok: false, error: { message: 'unexpected' } }));
    });
  });
  await new Promise(r => wss.once('listening', r));
  const run = (opts = {}) => exportHistory({ dataDir, stateDir, gatewayUrl: `ws://127.0.0.1:${wss.address().port}`, token: 't', print: () => {}, ...opts });
  const cleanup = async () => { await new Promise(r => wss.close(r)); fs.rmSync(dir, { recursive: true, force: true }); };
  return { run, cleanup, stateDir, connectParams: () => connect };
}

test('export-history copies the text as it was (the user\'s own history, same machine); check mode writes nothing', async () => {
  const f = await fixture();
  try {
    const checked = await f.run({ check: true });
    assert.deepEqual([checked.exported, checked.written], [1, []]);
    assert.equal(fs.existsSync(path.join(f.stateDir, 'agents')), false);
    const res = await f.run();
    assert.equal(res.exported, 1);
    const dir = path.join(f.stateDir, 'agents', 'main', 'sessions');
    assert.ok(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(n => n.endsWith('.jsonl'))), 'utf8').includes(KEY));
  } finally { await f.cleanup(); }
});

test('export-history connects with the connector\'s own scopes, so a gateway with roles still lists every session', async () => {
  const f = await fixture();
  try {
    await f.run({ check: true });
    const p = f.connectParams();
    assert.ok(p.scopes.includes('operator.read') && p.scopes.includes('operator.admin'));
  } finally { await f.cleanup(); }
});
