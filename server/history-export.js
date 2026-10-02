// `ocplatform clawchats export-history`: writes ClawChats chats that the gateway has no
// session for into the gateway's legacy session-store format (sessions.json + one JSONL
// transcript per chat) in each agent's sessions folder. The gateway's own importer
// (`ocplatform doctor --fix`, gateway stopped) then moves them into its database.
//
// Text only: ClawChats stored final reply text plus an activity summary, not full tool
// calls, so tool calls are not reconstructed (that would feed the model invented history).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { loadOrCreateDeviceIdentity, buildDeviceAuth } from './bootstrap/identity.js';
import { parseSessionKey } from './util/helpers.js';

const PLACEHOLDER_TITLES = new Set(['New chat', '']);

function withSuffix(base, n) {
  return n <= 1 ? base : `${base} (${n})`;
}

function isPushableTitle(title) {
  return typeof title === 'string' && !PLACEHOLDER_TITLES.has(title.trim());
}

const SKIP_CONTENT = new Set(['[Response interrupted]']);

/** One-shot gateway connection (same handshake as the connector's GatewayClient). */
export async function withGateway({ url, token, identityPath }, fn) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway at ${url} did not answer`)), 15000);
    ws.on('error', e => { clearTimeout(timer); reject(new Error(`cannot reach the gateway at ${url} (${e.message}) — is it running?`)); });
    ws.on('message', data => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const identity = loadOrCreateDeviceIdentity(identityPath);
        const scopes = ['operator.read'];
        const device = buildDeviceAuth(identity, { clientId: 'gateway-client', clientMode: 'backend', role: 'operator', scopes, token, nonce: msg.payload?.nonce || '' });
        ws.send(JSON.stringify({ type: 'req', id: 'connect', method: 'connect', params: { minProtocol: 3, maxProtocol: 4, client: { id: 'gateway-client', version: '0.1.0', platform: 'node', mode: 'backend' }, role: 'operator', scopes, device, auth: { token } } }));
        return;
      }
      if (msg.type === 'res' && msg.id === 'connect') {
        clearTimeout(timer);
        return msg.ok ? resolve() : reject(new Error(`gateway refused the connection: ${msg.error?.message || 'unknown error'}`));
      }
      if (msg.type === 'res' && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        msg.ok ? p.resolve(msg.payload) : p.reject(new Error(msg.error?.message || 'request failed'));
      }
    });
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = `export-${++seq}`;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
  try { await ready; return await fn(request); }
  finally { ws.close(); }
}

async function listAllSessions(request) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const res = await request('sessions.list', { archived: 'all', limit: 1000, offset });
    out.push(...(res?.sessions || []));
    if (!res?.hasMore || res.nextOffset == null) break;
    offset = res.nextOffset;
  }
  return out;
}

function readThreads(dataDir, project) {
  const file = path.join(dataDir, `${project.name}.db`);
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const cols = db.prepare('PRAGMA table_info(threads)').all().map(c => c.name);
    if (!cols.includes('session_key')) return [];
    const threads = db.prepare('SELECT id, title, session_key FROM threads').all();
    const msgStmt = db.prepare(`SELECT role, content, timestamp FROM messages WHERE thread_id = ? AND role IN ('user','assistant') AND content IS NOT NULL AND content != '' ORDER BY timestamp, rowid`);
    return threads.map(t => ({ ...t, project, messages: msgStmt.all(t.id).filter(m => !SKIP_CONTENT.has(m.content.trim())) }));
  } finally { db.close(); }
}

function transcriptLines(sessionId, cwd, messages) {
  const iso = ms => new Date(ms).toISOString();
  const lines = [{ type: 'session', version: 3, id: sessionId, timestamp: iso(messages[0].timestamp), cwd }];
  let parentId = null;
  for (const m of messages) {
    const id = crypto.randomBytes(4).toString('hex');
    const message = m.role === 'user'
      ? { role: 'user', content: m.content, timestamp: m.timestamp }
      : { role: 'assistant', content: [{ type: 'text', text: m.content }], stopReason: 'stop', timestamp: m.timestamp };
    lines.push({ type: 'message', id, parentId, timestamp: iso(m.timestamp), message });
    parentId = id;
  }
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

/**
 * @param {object} o
 * @param {string} o.dataDir     ClawChats data dir (workspaces.json + <project>.db)
 * @param {string} o.stateDir    gateway state dir (contains agents/<id>/sessions)
 * @param {string} o.gatewayUrl
 * @param {string} o.token
 * @param {boolean} [o.check]    report only, write nothing
 * @param {(line: string) => void} [o.print]
 * @returns {Promise<{ exported: number, skippedExisting: number, skippedEmpty: number, written: string[] }>}
 */
export async function exportHistory({ dataDir, stateDir, gatewayUrl, token, check = false, print = console.log }) {
  const workspaces = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspaces.json'), 'utf8'));
  const projects = Object.values(workspaces.workspaces || {}).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

  const sessions = await withGateway({ url: gatewayUrl, token, identityPath: path.join(dataDir, 'device-identity.json') }, listAllSessions);
  const existing = new Set(sessions.map(s => s.key));

  const perAgent = new Map(); // agentId -> [thread]
  const report = [];
  let skippedExisting = 0, skippedEmpty = 0;
  const allThreads = [];
  for (const project of projects) {
    const threads = readThreads(dataDir, project);
    allThreads.push(...threads);
    let exp = 0, have = 0, empty = 0;
    for (const t of threads) {
      const parsed = parseSessionKey(t.session_key);
      if (!parsed) continue;
      if (existing.has(t.session_key)) { have++; continue; }
      if (!t.messages.length) { empty++; continue; }
      if (!perAgent.has(parsed.agent)) perAgent.set(parsed.agent, []);
      perAgent.get(parsed.agent).push(t);
      exp++;
    }
    skippedExisting += have; skippedEmpty += empty;
    report.push({ project: project.label, threads: threads.length, export: exp, inGateway: have, empty });
  }

  // Titles that will get a " (n)" suffix once synced (gateway names are unique per agent).
  const taken = new Map(sessions.filter(s => s.label).map(s => [s.label, s.key]));
  const dupes = new Map();
  for (const t of allThreads) {
    if (!isPushableTitle(t.title)) continue;
    const owner = taken.get(t.title);
    if (owner === t.session_key) continue;
    if (owner) {
      let n = 2; while (taken.has(withSuffix(t.title, n))) n++;
      taken.set(withSuffix(t.title, n), t.session_key);
      dupes.set(t.title, (dupes.get(t.title) || 0) + 1);
    } else taken.set(t.title, t.session_key);
  }

  // Refuse before writing anything if an agent already has a pending legacy store.
  const targets = [...perAgent.keys()].map(agent => ({ agent, dir: path.join(stateDir, 'agents', agent, 'sessions') }));
  for (const { agent, dir } of targets) {
    const store = path.join(dir, 'sessions.json');
    if (fs.existsSync(store)) {
      throw new Error(`${store} already exists (an unfinished import for agent "${agent}"). Run \`ocplatform gateway stop && ocplatform doctor --fix && ocplatform gateway start\` first, then run export-history again.`);
    }
  }

  print('ClawChats history export' + (check ? ' (check only — nothing written)' : ''));
  print('');
  for (const r of report) print(`  ${r.project.padEnd(24)} ${String(r.export).padStart(4)} to import   ${String(r.inGateway).padStart(4)} already in gateway   ${r.empty ? `${r.empty} empty (skipped)` : ''}`);
  const total = [...perAgent.values()].reduce((n, l) => n + l.length, 0);
  print('');
  print(`  ${total} chats to import, ${skippedExisting} already in the gateway, ${skippedEmpty} empty.`);
  if (dupes.size) {
    print('');
    print('  Duplicate titles (gateway chat names must be unique; these get " (2)", " (3)"… in ClawChats and the gateway):');
    for (const [title, n] of [...dupes].sort((a, b) => b[1] - a[1])) print(`    ${String(n).padStart(4)} × "${title}"`);
  }

  const written = [];
  if (!check && total > 0) {
    for (const { agent, dir } of targets) {
      fs.mkdirSync(dir, { recursive: true });
      const cwd = path.join(stateDir, agent === 'main' ? 'workspace' : `workspace-${agent}`);
      const store = {};
      for (const t of perAgent.get(agent)) {
        const sessionId = crypto.randomUUID();
        const sessionFile = path.join(dir, `${sessionId}.jsonl`);
        fs.writeFileSync(sessionFile, transcriptLines(sessionId, cwd, t.messages));
        const start = t.messages[0].timestamp, end = t.messages[t.messages.length - 1].timestamp;
        store[t.session_key] = { sessionId, sessionFile, updatedAt: end, sessionStartedAt: start, lastInteractionAt: end, chatType: 'direct', lastChannel: 'webchat' };
        written.push(sessionFile);
      }
      const storePath = path.join(dir, 'sessions.json');
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
      written.push(storePath);
    }
    print('');
    print('  Written. Finish the import now (the gateway is offline for a minute or two):');
    print('');
    print('    ocplatform gateway stop');
    print('    ocplatform doctor --fix');
    print('    ocplatform gateway start');
    print('');
    print('  Run these right away: until `doctor --fix` runs, the gateway refuses to restart.');
  } else if (check) {
    print('');
    print('  Run `ocplatform clawchats export-history` (without "check") to write the files.');
  } else {
    print('');
    print('  Nothing to import.');
  }
  return { exported: total, skippedExisting, skippedEmpty, written };
}
