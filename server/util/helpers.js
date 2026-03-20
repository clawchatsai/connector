export function syncThreadUnreadCount(db, threadId) {
  const count = db.prepare('SELECT COUNT(*) as c FROM unread_messages WHERE thread_id = ?').get(threadId).c;
  db.prepare('UPDATE threads SET unread_count = ? WHERE id = ?').run(count, threadId);
  return count;
}

export function parseSessionKey(sessionKey) {
  if (!sessionKey) return null;
  const match = sessionKey.match(/^agent:([^:]+):([^:]+):chat:([^:]+)$/);
  if (!match) return null;
  return { agent: match[1], workspace: match[2], threadId: match[3] };
}

export function extractContent(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(p => p.type === 'text').map(p => p.text).join('');
  }
  return '';
}

export function isSilentReplyExact(text, token = 'NO_REPLY') {
  if (!text) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*$`).test(text);
}

export function isSilentReplyPrefix(text, token = 'NO_REPLY') {
  if (!text) return false;
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  if (trimmed !== trimmed.toUpperCase()) return false;
  const normalized = trimmed.toUpperCase();
  if (normalized.length < 2 || /[^A-Z_]/.test(normalized)) return false;
  const tokenUpper = token.toUpperCase();
  if (!tokenUpper.startsWith(normalized)) return false;
  if (normalized.includes('_')) return true;
  return tokenUpper === 'NO_REPLY' && normalized === 'NO';
}

export function stripTrailingSentinel(text, token = 'NO_REPLY') {
  if (!text) return text;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?:^|\\s+|\\*+)${escaped}\\s*$`), '').trim();
}

export function stripFinalTags(text) {
  return text ? text.replace(/<\s*\/?\s*final\s*>/gi, '') : text;
}

export function sanitizeAssistantContent(text) {
  if (!text) return text;
  let out = stripFinalTags(text);
  out = out.replace(/^(?:[ \t]*\r?\n)+/, '');
  if (out.includes('NO_REPLY'))     out = stripTrailingSentinel(out, 'NO_REPLY');
  if (out.includes('HEARTBEAT_OK')) out = stripTrailingSentinel(out, 'HEARTBEAT_OK');
  return out;
}

export function generateActivitySummary(steps) {
  const toolSteps = steps.filter(s => s.type === 'tool' && s.phase !== 'result' && s.phase !== 'update');
  const hasThinking = steps.some(s => s.type === 'thinking' && s.text);
  const hasNarration = steps.some(s => s.type === 'assistant' && s.text?.trim());
  if (toolSteps.length === 0 && !hasThinking && !hasNarration) return null;
  if (toolSteps.length === 0 && hasThinking) return 'Reasoned through the problem';
  if (toolSteps.length === 0 && hasNarration) return 'Processed in multiple steps';
  const counts = {};
  for (const s of toolSteps) { const name = s.name || 'unknown'; counts[name] = (counts[name] || 0) + 1; }
  const toolNames = { web_search: 'searched the web', web_fetch: 'fetched web pages', Read: 'read files', read: 'read files', Write: 'wrote files', write: 'wrote files', Edit: 'edited files', edit: 'edited files', exec: 'ran commands', Bash: 'ran commands', browser: 'browsed the web', memory_search: 'searched memory', memory_store: 'saved to memory', image: 'analyzed images', message: 'sent messages', sessions_spawn: 'spawned sub-agents', cron: 'managed cron jobs', Grep: 'searched code', grep: 'searched code', Glob: 'found files', glob: 'found files' };
  const parts = [];
  for (const [name, count] of Object.entries(counts)) {
    const friendly = toolNames[name];
    parts.push(friendly ? (count > 1 ? `${friendly} (${count}×)` : friendly) : (count > 1 ? `used ${name} (${count}×)` : `used ${name}`));
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const last = parts.pop();
  return (parts.join(', ') + ' and ' + last).replace(/^./, c => c.toUpperCase());
}

export function writeActivityToDb(getDbFn, broadcastFn, runId, log) {
  if (!log._parsed) log._parsed = parseSessionKey(log.sessionKey);
  const parsed = log._parsed;
  if (!parsed) return;
  const db = getDbFn(parsed.workspace);
  if (!db) return;
  const cleanSteps = log.steps.map(s => { const c = { ...s }; delete c._sealed; return c; });
  const summary = generateActivitySummary(log.steps);
  const now = Date.now();
  if (!log._messageId) {
    const thread = db.prepare('SELECT id FROM threads WHERE id = ?').get(parsed.threadId);
    if (!thread) return;
    const messageId = `gw-activity-${runId}`;
    const metadata = { activityLog: cleanSteps, activitySummary: summary, pending: true };
    try {
      db.prepare(`INSERT OR IGNORE INTO messages (id, thread_id, role, content, status, metadata, timestamp, created_at) VALUES (?, ?, 'assistant', '', 'sent', ?, ?, ?)`).run(messageId, parsed.threadId, JSON.stringify(metadata), now, now);
      log._messageId = messageId;
      broadcastFn(JSON.stringify({ type: 'clawchats', event: 'message-saved', threadId: parsed.threadId, workspace: parsed.workspace, messageId, timestamp: now }));
    } catch (err) {
      console.error(`[activity] Failed to write activity ${messageId}:`, err.message);
    }
  } else {
    const existing = db.prepare('SELECT metadata FROM messages WHERE id = ?').get(log._messageId);
    const metadata = existing?.metadata ? JSON.parse(existing.metadata) : {};
    metadata.activityLog = cleanSteps;
    metadata.activitySummary = summary;
    metadata.pending = true;
    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), log._messageId);
  }
}
