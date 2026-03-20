import fs from 'node:fs';
import path from 'node:path';
import { MAX_PREAMBLE_CHARS, getSessionsDirForAgent } from '../config.js';

export function buildContextPreamble(db, threadId, lastSessionId, sessionKey) {
  let summary = null;
  let method = 'raw';

  if (lastSessionId) {
    const agentMatch = (sessionKey || '').match(/^agent:([^:]+):/);
    const sessionsDir = getSessionsDirForAgent(agentMatch?.[1]);
    try {
      const lines = fs.readFileSync(path.join(sessionsDir, `${lastSessionId}.jsonl`), 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'compaction' && entry.summary) { summary = entry.summary; method = 'compaction'; break; }
        } catch { /* skip malformed */ }
      }
    } catch { /* file not found */ }
  }

  let preamble = '';
  if (method === 'compaction' && summary) {
    preamble += "[CONTEXT RECOVERY — This thread's agent session was reset. Below is a summary of the previous conversation followed by recent messages to restore context.]\n\n";
    preamble += '[CONVERSATION SUMMARY]\n' + summary + '\n\n';
    const msgs = db.prepare('SELECT role, content, timestamp FROM messages WHERE thread_id = ? ORDER BY timestamp DESC LIMIT 10').all(threadId).reverse();
    if (msgs.length) {
      preamble += '[RECENT MESSAGES]\n';
      for (const m of msgs) {
        const ts = new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 16);
        preamble += `${m.role.charAt(0).toUpperCase() + m.role.slice(1)} (${ts}): ${m.content}\n`;
      }
    }
  } else {
    preamble += "[CONTEXT RECOVERY — This thread's agent session was reset. Below are recent messages from the previous conversation to restore context.]\n\n";
    const msgs = db.prepare('SELECT role, content, timestamp FROM messages WHERE thread_id = ? ORDER BY timestamp DESC LIMIT 25').all(threadId).reverse();
    if (msgs.length) {
      preamble += '[PREVIOUS MESSAGES]\n';
      for (const m of msgs) {
        const ts = new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 16);
        preamble += `${m.role.charAt(0).toUpperCase() + m.role.slice(1)} (${ts}): ${m.content}\n`;
      }
    }
  }

  if (preamble.length > MAX_PREAMBLE_CHARS) preamble = preamble.slice(preamble.length - MAX_PREAMBLE_CHARS);
  return { preamble, method };
}
