import fs from 'node:fs';
import path from 'node:path';
import { MAX_PREAMBLE_CHARS, getSessionsDirForAgent, sessionTranscriptPath } from '../config.js';

export function buildContextPreamble(db, threadId, lastSessionId, sessionKey) {
  let summary = null;
  let method = 'raw';

  if (lastSessionId) {
    const agentMatch = (sessionKey || '').match(/^agent:([^:]+):/);
    const sessionsDir = getSessionsDirForAgent(agentMatch?.[1]);
    // sessionTranscriptPath() returns null for an id that cannot be a filename, and
    // this was the one of its four call sites that did not check. It was harmless
    // only by accident: fs.readFileSync(null) throws ERR_INVALID_ARG_TYPE, which the
    // catch below swallowed along with the ENOENT it was written for. Narrowing that
    // catch to ENOENT — an obvious tidy-up — would turn a rejected id into a
    // TypeError on the message-send path. Skip instead, as the other three sites do.
    const transcript = sessionTranscriptPath(sessionsDir, lastSessionId);
    if (transcript) {
      try {
        const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.type === 'compaction' && entry.summary) { summary = entry.summary; method = 'compaction'; break; }
          } catch { /* skip malformed */ }
        }
      } catch { /* file not found */ }
    }
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
