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
// Refuses two cases rather than guessing, leaving the old entry alone in both. Neither
// refusal is harmless, so both are logged — the alternative in each case is worse, but
// the cost is real and has to be diagnosable:
//   - the agent changed. sessions.json is resolved per *agent*, so this would have to
//     relocate the .jsonl across agent directories, and a session one agent recorded is
//     not resumable by another. This is the common path, not an edge case: per-workspace
//     agents are first class. The moved thread stores the *new* key, so the old entry
//     and its .jsonl are afterwards collected by no path at all — one leaked transcript
//     per refused move.
//   - the new key is already taken, which means a stale entry is squatting on it.
//     Overwriting would strand that entry's transcript; refusing means the moved thread
//     resumes it instead of its own. Refusing does not cause that — the warning is what
//     makes it findable.
// Returns true only when the entry actually moved.
export function renameGatewaySession(oldKey, newKey) {
  const agent = (oldKey || '').match(/^agent:([^:]+):/)?.[1];
  if (!agent || agent !== (newKey || '').match(/^agent:([^:]+):/)?.[1]) {
    if (oldKey) console.warn(`renameGatewaySession: agent differs between "${oldKey}" and "${newKey}"; the transcript stays on the old key, which nothing now points at`);
    return false;
  }
  try {
    const sessionsPath = path.join(getSessionsDirForAgent(agent), 'sessions.json');
    const store = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    if (!store[oldKey]) return false;
    if (store[newKey]) {
      console.warn(`renameGatewaySession: "${newKey}" is already held by a stale session entry; the moved thread will resume that transcript rather than its own`);
      return false;
    }
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
