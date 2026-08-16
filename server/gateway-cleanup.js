import fs from 'node:fs';
import path from 'node:path';
import { getSessionsDirForAgent } from './config.js';

export function cleanGatewaySession(sessionKey) {
  try {
    const agentMatch = (sessionKey || '').match(/^agent:([^:]+):/);
    const sessionsDir = getSessionsDirForAgent(agentMatch?.[1]);
    const sessionsPath = path.join(sessionsDir, 'sessions.json');
    const store = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    const entry = store[sessionKey];
    if (!entry) return null;
    if (entry.sessionId) {
      try { fs.unlinkSync(path.join(sessionsDir, `${entry.sessionId}.jsonl`)); } catch { /* ok */ }
    }
    const sessionId = entry.sessionId || null;
    delete store[sessionKey];
    fs.writeFileSync(sessionsPath, JSON.stringify(store, null, 2));
    return sessionId;
  } catch (err) {
    console.warn(`cleanGatewaySession(${sessionKey}):`, err.message);
    return null;
  }
}

// Re-point an existing gateway session at a new session key, so a thread that moved
// between workspaces keeps its transcript instead of silently starting over.
//
// Refuses two cases rather than guessing, in both of which the old entry is left
// alone — inert, exactly as repairSessionKeyWorkspace() leaves its stale keys:
//   - the agent changed. sessions.json is resolved per *agent*, so this would have to
//     relocate the .jsonl across agent directories, and a session one agent recorded
//     is not resumable by another.
//   - the new key is already taken. Overwriting it would strand the transcript of
//     whatever thread already owns it.
// Returns true only when the entry actually moved.
export function renameGatewaySession(oldKey, newKey) {
  const agent = (oldKey || '').match(/^agent:([^:]+):/)?.[1];
  if (!agent || agent !== (newKey || '').match(/^agent:([^:]+):/)?.[1]) return false;
  try {
    const sessionsPath = path.join(getSessionsDirForAgent(agent), 'sessions.json');
    const store = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    if (!store[oldKey] || store[newKey]) return false;
    store[newKey] = store[oldKey];
    delete store[oldKey];
    fs.writeFileSync(sessionsPath, JSON.stringify(store, null, 2));
    return true;
  } catch (err) {
    console.warn(`renameGatewaySession(${oldKey} -> ${newKey}):`, err.message);
    return false;
  }
}

export function cleanGatewaySessionsByPrefix(prefix) {
  try {
    const agentMatch = (prefix || '').match(/^agent:([^:]+):/);
    const sessionsDir = getSessionsDirForAgent(agentMatch?.[1]);
    const sessionsPath = path.join(sessionsDir, 'sessions.json');
    const store = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    let cleaned = 0;
    for (const key of Object.keys(store)) {
      if (!key.startsWith(prefix)) continue;
      if (store[key]?.sessionId) {
        try { fs.unlinkSync(path.join(sessionsDir, `${store[key].sessionId}.jsonl`)); } catch { /* ok */ }
      }
      delete store[key];
      cleaned++;
    }
    if (cleaned > 0) fs.writeFileSync(sessionsPath, JSON.stringify(store, null, 2));
    return cleaned;
  } catch (err) {
    console.warn(`cleanGatewaySessionsByPrefix(${prefix}):`, err.message);
    return 0;
  }
}
