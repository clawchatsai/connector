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
