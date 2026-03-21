import path from 'node:path';
import { WebSocket as WS } from 'ws';
import { loadOrCreateDeviceIdentity, buildDeviceAuth } from './bootstrap/identity.js';
import { parseSessionKey, extractContent, isSilentReplyExact, isSilentReplyPrefix, sanitizeAssistantContent, syncThreadUnreadCount, generateActivitySummary, writeActivityToDb } from './util/helpers.js';

export class GatewayClient {
  constructor({ getDb, getWorkspaces, dataDir, debugLogger, gatewayWsUrl, authToken, mediaStash }) {
    this.getDb = getDb;
    this.getWorkspaces = getWorkspaces;
    this.dataDir = dataDir;
    this.debugLogger = debugLogger;
    this.gatewayWsUrl = gatewayWsUrl;
    this.authToken = authToken;
    this.mediaStash = mediaStash;

    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.browserClients = new Map();
    this._externalBroadcastTargets = [];
    this.streamState = new Map();
    this.activityLogs = new Map();
    this._pendingTitleGens = new Map();

    // Periodically clean up stale activity logs (>10 min old)
    setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [runId, log] of this.activityLogs) {
        if (log.startTime < cutoff) {
          if (log._messageId) {
            const db = this.getDb(log._parsed?.workspace);
            if (db) db.prepare(`UPDATE messages SET content = '[Response interrupted]', metadata = json_remove(metadata, '$.pending') WHERE id = ? AND content = ''`).run(log._messageId);
          }
          this.activityLogs.delete(runId);
        }
      }
    }, 5 * 60 * 1000);
  }

  connect() {
    if (this.ws && (this.ws.readyState === WS.CONNECTING || this.ws.readyState === WS.OPEN)) return;
    console.log(`Connecting to gateway at ${this.gatewayWsUrl}...`);
    this.ws = new WS(this.gatewayWsUrl);
    this.ws.on('open', () => { console.log('Gateway WebSocket connected'); this.reconnectAttempts = 0; });
    this.ws.on('message', data => this.handleGatewayMessage(data.toString()));
    this.ws.on('close', () => { console.log('Gateway WebSocket closed'); this.connected = false; this.broadcastGatewayStatus(false); this.scheduleReconnect(); });
    this.ws.on('error', err => console.error('Gateway WebSocket error:', err.message));
  }

  handleGatewayMessage(data) {
    this.debugLogger.logFrame('GW→SRV', data);
    let msg;
    try { msg = JSON.parse(data); } catch { console.error('Invalid JSON from gateway:', data); return; }

    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const identity = loadOrCreateDeviceIdentity(path.join(this.dataDir, 'device-identity.json'));
      const device = buildDeviceAuth(identity, { clientId: 'gateway-client', clientMode: 'backend', role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], token: this.authToken, nonce: msg.payload?.nonce || '' });
      this.ws.send(JSON.stringify({ type: 'req', id: 'gw-connect-1', method: 'connect', params: { minProtocol: 3, maxProtocol: 3, client: { id: 'gateway-client', version: '0.1.0', platform: 'node', mode: 'backend' }, role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], device, auth: { token: this.authToken }, caps: ['tool-events'] } }));
      return;
    }
    if (msg.type === 'res' && msg.payload?.type === 'hello-ok') { console.log('Gateway handshake complete'); this.connected = true; this.broadcastGatewayStatus(true); }
    if (msg.type === 'event' && msg.event === 'chat' && msg.payload) {
      this.handleChatEvent(msg.payload, data);
    } else {
      this.broadcastToBrowsers(data);
    }
    if (msg.type === 'event' && msg.event === 'agent' && msg.payload) this.handleAgentEvent(msg.payload);
  }

  handleChatEvent(params, rawData) {
    const { sessionKey, state, message, seq } = params;
    const bareSessionKey = sessionKey.replace(/^agent:[^:]+:/, '');

    // --- Utility session routing (connector-side) ---
    // Emits semantic utility-response events. Also forwards rawData for dual-emit compatibility
    // during transition — browser handleChatEvent guards these and defers to utility-response handler.
    const UTILITY_SESSIONS = { '__clawchats_summarizer': 'summarizer', '__clawchats_semantic': 'semantic', '__clawchats_intelligence': 'intelligence' };
    const utilityName = UTILITY_SESSIONS[bareSessionKey];
    if (utilityName) {
      const content = extractContent(message);
      if (state === 'delta' && content) {
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'utility-response', session: utilityName, state: 'delta', content }));
      } else if (state === 'final' || state === 'aborted') {
        if (content) this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'utility-response', session: utilityName, state: state === 'final' ? 'final' : 'aborted', content }));
      } else if (state === 'error') {
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'utility-response', session: utilityName, state: 'error', errorMessage: message?.error || 'Unknown error' }));
      }
      this.broadcastToBrowsers(rawData); // dual-emit: browser guard skips raw handling for utility sessions
      return;
    }

    // --- Delta path ---
    if (state === 'delta') {
      const parsed = parseSessionKey(sessionKey);
      if (parsed) {
        const existing = this.streamState.get(sessionKey) || { buffer: '', threadId: parsed.threadId, state: 'streaming', held: [] };
        existing.buffer = extractContent(message); // gateway sends full cumulative content per delta, not chunks
        if (isSilentReplyPrefix(existing.buffer, 'NO_REPLY') || isSilentReplyPrefix(existing.buffer, 'HEARTBEAT_OK')) {
          existing.held = existing.held || [];
          existing.held.push(rawData);
          this.streamState.set(sessionKey, existing);
          return;
        }
        if (existing.held?.length > 0) {
          for (const h of existing.held) this.broadcastToBrowsers(h);
          existing.held = [];
        }
        this.streamState.set(sessionKey, existing);
        this.broadcastToBrowsers(rawData); // dual-emit: raw chat event (old protocol)
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-delta', threadId: parsed.threadId, workspace: parsed.workspace, content: existing.buffer }));
      } else {
        this.broadcastToBrowsers(rawData); // non-clawchats session (discord, telegram, etc.)
      }
      return;
    }

    // --- End states ---
    const streamEntry = this.streamState.get(sessionKey);
    if (state === 'final' || state === 'aborted' || state === 'error') this.streamState.delete(sessionKey);

    // Title sessions are handled server-side — intercept and skip browser delivery
    if (sessionKey?.includes('__clawchats_title_')) {
      if (state === 'final') { const content = extractContent(message); if (content && this.handleTitleResponse(sessionKey, content)) return; }
      else if (state === 'error' || state === 'aborted') { for (const key of this._pendingTitleGens.keys()) { if (sessionKey === key || sessionKey.includes(key)) { this._pendingTitleGens.delete(key); break; } } return; }
      return;
    }

    if (state === 'final') {
      const rawContent = extractContent(message);
      const parsed = parseSessionKey(sessionKey);
      if (isSilentReplyExact(rawContent, 'NO_REPLY') || isSilentReplyExact(rawContent, 'HEARTBEAT_OK')) {
        this._cleanupSilentPending(sessionKey);
        if (parsed) this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-end', threadId: parsed.threadId, workspace: parsed.workspace, reason: 'silent' }));
        return;
      }
      if (streamEntry?.held?.length > 0) for (const h of streamEntry.held) this.broadcastToBrowsers(h);
      this.saveAssistantMessage(sessionKey, message, seq); // persist + broadcast message-saved first
      this.broadcastToBrowsers(rawData);                   // dual-emit: raw final event
      if (parsed) {
        const activity = this._popActivityLogForSession(sessionKey);
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-end', threadId: parsed.threadId, workspace: parsed.workspace, reason: 'complete', ...(activity || {}) }));
      }
      return;
    }
    if (state === 'aborted') {
      const parsed = parseSessionKey(sessionKey);
      this.broadcastToBrowsers(rawData); // dual-emit
      if (parsed) {
        const activity = this._popActivityLogForSession(sessionKey);
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-end', threadId: parsed.threadId, workspace: parsed.workspace, reason: 'aborted', ...(activity || {}) }));
      }
    } else if (state === 'error') {
      const parsed = parseSessionKey(sessionKey);
      this.saveErrorMarker(sessionKey, message);
      this.broadcastToBrowsers(rawData); // dual-emit
      if (parsed) {
        const activity = this._popActivityLogForSession(sessionKey);
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-end', threadId: parsed.threadId, workspace: parsed.workspace, reason: 'error', errorMessage: message?.error || 'Unknown error', ...(activity || {}) }));
      }
    }
  }

  _cleanupSilentPending(sessionKey) {
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) return;
    const ws = this.getWorkspaces();
    if (!ws.workspaces[parsed.workspace]) return;
    const db = this.getDb(parsed.workspace);
    if (!db) return;
    const result = db.prepare(`DELETE FROM messages WHERE thread_id = ? AND role = 'assistant' AND json_extract(metadata, '$.pending') = 1`).run(parsed.threadId);
    if (result.changes > 0) console.log(`[clawchats] silent-reply cleanup: removed ${result.changes} pending message(s) for ${parsed.threadId}`);
    // Caller broadcasts streaming-end { reason: 'silent' } — no event emitted here.
  }

  saveAssistantMessage(sessionKey, message, seq) {
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) return;
    const ws = this.getWorkspaces();
    if (!ws.workspaces[parsed.workspace]) { console.log(`Ignoring response for deleted workspace: ${parsed.workspace}`); return; }
    const db = this.getDb(parsed.workspace);
    if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(parsed.threadId)) { console.log(`Ignoring response for deleted thread: ${parsed.threadId}`); return; }

    let content = sanitizeAssistantContent(extractContent(message));

    // Attach media (MEDIA: lines from exec stdout captured by after_tool_call hook).
    // Stash is read before the empty-content guard — media-only responses (no text) must not be dropped.
    const pendingPaths = this.mediaStash?.get(sessionKey) ?? [];
    this.mediaStash?.delete(sessionKey);
    const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','bmp','svg','ico','avif','tiff']);
    const AUDIO_EXTS = new Set(['mp3','wav','ogg','m4a','flac','aac','opus','wma']);
    const imagePaths = [], pendingAttachments = [];
    for (const p of pendingPaths) {
      const ext = (p.split('.').pop() || '').toLowerCase();
      if (IMAGE_EXTS.has(ext)) imagePaths.push(p);
      else pendingAttachments.push({ path: p, name: p.split('/').pop(), type: AUDIO_EXTS.has(ext) ? 'audio' : 'file' });
    }
    if (imagePaths.length > 0) content = (content?.trimEnd() || '') + '\n\n' + imagePaths.map(p => `![image](${p})`).join('\n');
    if (pendingPaths.length > 0) console.log(`[clawchats] media-attach: ${imagePaths.length} image(s), ${pendingAttachments.length} attachment(s) for ${sessionKey}`);

    // Skip only if there is truly nothing to save — no text and no pending media.
    if (!content?.trim() && pendingPaths.length === 0) { console.log(`Skipping empty assistant response for thread ${parsed.threadId}`); return; }

    const now = Date.now();
    const pendingMsg = db.prepare(`SELECT id, metadata FROM messages WHERE thread_id = ? AND role = 'assistant' AND json_extract(metadata, '$.pending') = 1 ORDER BY timestamp DESC LIMIT 1`).get(parsed.threadId);
    let messageId;

    if (pendingMsg) {
      const metadata = pendingMsg.metadata ? JSON.parse(pendingMsg.metadata) : {};
      delete metadata.pending;
      if (metadata.activityLog) { const idx = metadata.activityLog.findLastIndex(s => s.type === 'assistant'); if (idx >= 0) metadata.activityLog.splice(idx, 1); metadata.activitySummary = generateActivitySummary(metadata.activityLog); }
      if (pendingAttachments.length > 0) metadata.attachments = [...(metadata.attachments || []), ...pendingAttachments];
      db.prepare('UPDATE messages SET content = ?, metadata = ?, timestamp = ? WHERE id = ?').run(content, JSON.stringify(metadata), now, pendingMsg.id);
      messageId = pendingMsg.id;
    } else {
      messageId = seq != null ? `gw-${parsed.threadId}-${seq}` : `gw-${parsed.threadId}-${now}`;
      const newMeta = pendingAttachments.length > 0 ? JSON.stringify({ attachments: pendingAttachments }) : null;
      db.prepare(`INSERT INTO messages (id, thread_id, role, content, status, metadata, timestamp, created_at) VALUES (?, ?, 'assistant', ?, 'sent', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, metadata = COALESCE(excluded.metadata, metadata), timestamp = excluded.timestamp`).run(messageId, parsed.threadId, content, newMeta, now, now);
    }

    try {
      db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, parsed.threadId);
      db.prepare('INSERT OR IGNORE INTO unread_messages (thread_id, message_id, created_at) VALUES (?, ?, ?)').run(parsed.threadId, messageId, now);
      syncThreadUnreadCount(db, parsed.threadId);
      const threadInfo = db.prepare('SELECT title FROM threads WHERE id = ?').get(parsed.threadId);
      const unreadCount = db.prepare('SELECT COUNT(*) as c FROM unread_messages WHERE thread_id = ?').get(parsed.threadId).c;
      const preview = content.length > 120 ? content.substring(0, 120) + '...' : content;
      this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'message-saved', threadId: parsed.threadId, workspace: parsed.workspace, messageId, timestamp: now, title: threadInfo?.title, preview, unreadCount, updatedContent: imagePaths.length > 0 ? content : undefined, updatedAttachments: pendingAttachments.length > 0 ? pendingAttachments : undefined }));
      this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'unread-update', workspace: parsed.workspace, threadId: parsed.threadId, messageId, action: 'new', unreadCount, workspaceUnreadTotal: db.prepare('SELECT COALESCE(SUM(unread_count), 0) as total FROM threads').get().total, title: threadInfo?.title, preview, timestamp: now }));
      console.log(`Saved assistant message to ${parsed.workspace}/${parsed.threadId} (${pendingMsg ? 'merged into pending' : 'seq: ' + seq})`);
      const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE thread_id = ?').get(parsed.threadId).c;
      if (msgCount === 2 || threadInfo?.title === 'New chat') this.generateThreadTitle(db, parsed.threadId, parsed.workspace, true);
    } catch (e) { console.error('Failed to save assistant message:', e.message); }
  }

  saveErrorMarker(sessionKey, message) {
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) return;
    const ws = this.getWorkspaces();
    if (!ws.workspaces[parsed.workspace]) return;
    const db = this.getDb(parsed.workspace);
    if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(parsed.threadId)) return;
    const now = Date.now();
    try {
      db.prepare('INSERT INTO messages (id, thread_id, role, content, status, metadata, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(`gw-error-${parsed.threadId}-${now}`, parsed.threadId, 'system', `[error] ${message?.error || message?.content || 'Unknown error'}`, 'sent', '{"transient":true}', now, now);
    } catch (e) { console.error('Failed to save error marker:', e.message); }
  }

  generateThreadTitle(db, threadId, workspace, skipHeuristic = false) {
    if (!db.prepare('SELECT title FROM threads WHERE id = ?').get(threadId)) return;
    const titleKey = `__clawchats_title_${threadId}`;
    if (this._pendingTitleGens.has(titleKey)) return;
    const firstUserMsg = db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1").get(threadId);
    if (!firstUserMsg?.content) return;
    if (!skipHeuristic) {
      const heuristic = firstUserMsg.content.replace(/\n.*/s, '').slice(0, 40).trim() + (firstUserMsg.content.length > 40 ? '...' : '');
      db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(heuristic, threadId);
      this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'thread-title-updated', threadId, workspace, title: heuristic }));
    }
    const messages = db.prepare('SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT 6').all(threadId);
    if (messages.length < 2) return;
    const conversation = messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content}`).join('\n\n');
    const reqId = `title-${threadId}-${Date.now()}`;
    this._pendingTitleGens.set(titleKey, { threadId, workspace, reqId });
    setTimeout(() => { if (this._pendingTitleGens.has(titleKey)) { this._pendingTitleGens.delete(titleKey); console.log(`Title gen timeout for ${threadId}`); } }, 30000);
    this.sendToGateway(JSON.stringify({ type: 'req', id: reqId, method: 'chat.send', params: { sessionKey: titleKey, message: `Based on this conversation, generate a concise 3-5 word title. Return ONLY the title text, no quotes, no explanation:\n\n${conversation}\n\nTitle:`, deliver: false, idempotencyKey: reqId } }));
  }

  handleTitleResponse(sessionKey, content) {
    let matchKey = null, pending = null;
    for (const [key, val] of this._pendingTitleGens) {
      if (sessionKey === key || sessionKey.includes(key)) { matchKey = key; pending = val; break; }
    }
    if (!pending) return false;
    this._pendingTitleGens.delete(matchKey);
    let title = content.trim().replace(/^["']|["']$/g, '').replace(/^Title:\s*/i, '').replace(/\n.*/s, '').trim();
    if (title.length > 50) title = title.substring(0, 47) + '...';
    if (!title || title.length >= 100) return true;
    const db = this.getDb(pending.workspace);
    db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, pending.threadId);
    this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'thread-title-updated', threadId: pending.threadId, workspace: pending.workspace, title }));
    console.log(`AI title generated for ${pending.threadId}: "${title}"`);
    return true;
  }

  handleAgentEvent(payload) {
    const { runId, stream, data, sessionKey } = payload;
    if (!runId) return;
    if (!this.activityLogs.has(runId)) this.activityLogs.set(runId, { sessionKey, steps: [], startTime: Date.now() });
    const log = this.activityLogs.get(runId);

    if (stream === 'assistant') {
      const text = data?.text || '';
      if (text) {
        const offset = log._assistantTextOffset || 0;
        let seg = log._currentAssistantSegment;
        if (!seg || seg._sealed) {
          seg = { type: 'assistant', timestamp: Date.now(), text: text.substring(offset), _sealed: false };
          log._currentAssistantSegment = seg;
          log.steps.push(seg);
        } else {
          seg.text = text.substring(offset);
        }
      }
      return;
    }
    if (stream === 'thinking') {
      let step = log.steps.find(s => s.type === 'thinking');
      if (step) step.text = data?.text || '';
      else log.steps.push({ type: 'thinking', timestamp: Date.now(), text: data?.text || '' });
      writeActivityToDb(this.getDb, this.broadcastToBrowsers.bind(this), runId, log);
      const now = Date.now();
      if (!log._lastThinkingBroadcast || now - log._lastThinkingBroadcast >= 300) { log._lastThinkingBroadcast = now; this._broadcastActivityUpdate(runId, log); }
    }
    if (stream === 'tool') {
      if (log._currentAssistantSegment && !log._currentAssistantSegment._sealed) {
        const seg = log._currentAssistantSegment;
        seg._sealed = true;
        log._assistantTextOffset = (log._assistantTextOffset || 0) + seg.text.length;
      }
      const argsMeta = data?.args ? (data.args.command || data.args.path || data.args.query || data.args.url || Object.values(data.args).find(v => typeof v === 'string') || '') : '';
      const step = { type: 'tool', timestamp: Date.now(), name: data?.name || 'unknown', phase: data?.phase || 'start', toolCallId: data?.toolCallId, meta: data?.meta || (argsMeta ? String(argsMeta) : undefined), isError: data?.isError || false };
      if (data?.phase === 'result') {
        const existing = log.steps.findLast(s => s.toolCallId === data.toolCallId && (s.phase === 'start' || s.phase === 'running'));
        if (existing) { existing.phase = 'done'; existing.resultMeta = data?.meta; existing.isError = data?.isError || false; existing.durationMs = Date.now() - existing.timestamp; }
        else { step.phase = 'done'; log.steps.push(step); }
      } else if (data?.phase === 'update') {
        const existing = log.steps.findLast(s => s.toolCallId === data.toolCallId);
        if (existing) { if (data?.meta) existing.resultMeta = data.meta; if (data?.isError) existing.isError = true; existing.phase = 'running'; }
      } else log.steps.push(step);
      writeActivityToDb(this.getDb, this.broadcastToBrowsers.bind(this), runId, log);
      this._broadcastActivityUpdate(runId, log);
    }
    if (stream === 'lifecycle' && (data?.phase === 'end' || data?.phase === 'error')) {
      if (log._currentAssistantSegment && !log._currentAssistantSegment._sealed) {
        const seg = log._currentAssistantSegment;
        seg._sealed = true;
        log._assistantTextOffset = (log._assistantTextOffset || 0) + seg.text.length;
      }
      const idx = log.steps.findLastIndex(s => s.type === 'assistant');
      if (idx >= 0) log.steps.splice(idx, 1);
      writeActivityToDb(this.getDb, this.broadcastToBrowsers.bind(this), runId, log);
      // Store finalized state — streaming-end (handleChatEvent) will pick it up and carry it
      // as one atomic payload. Do NOT broadcast activity-updated here anymore.
      const cleanSteps = log.steps.map(s => { const c = { ...s }; delete c._sealed; return c; });
      log.finalized = true;
      log.finalSteps = cleanSteps;
      log.finalSummary = generateActivitySummary(log.steps);
      // Note: activityLogs entry is kept until _popActivityLogForSession cleans it up
    }
  }

  // Returns and removes the finalized activity log for a given sessionKey, or null if none.
  // Called by handleChatEvent so streaming-end carries the final activity state atomically.
  _popActivityLogForSession(sessionKey) {
    for (const [runId, log] of this.activityLogs) {
      if (log.sessionKey === sessionKey && log.finalized) {
        this.activityLogs.delete(runId);
        return { activityLog: log.finalSteps, activitySummary: log.finalSummary };
      }
    }
    return null;
  }

  _broadcastActivityUpdate(runId, log) {
    if (!log._parsed || !log._messageId) return;
    const cleanSteps = log.steps.map(s => { const c = { ...s }; delete c._sealed; return c; });
    this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'activity-updated', workspace: log._parsed.workspace, threadId: log._parsed.threadId, messageId: log._messageId, activityLog: cleanSteps, activitySummary: generateActivitySummary(log.steps) }));
  }

  broadcastToBrowsers(data) {
    this.debugLogger.logFrame('SRV→BR', data);
    for (const client of this.browserClients.keys()) { if (client.readyState === WS.OPEN) client.send(data); }
    for (const fn of this._externalBroadcastTargets) { try { fn(data); } catch { /* target disconnected */ } }
  }

  broadcastGatewayStatus(connected) {
    this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'gateway-status', connected }));
  }

  sendToGateway(data) {
    this.debugLogger.logFrame('SRV→GW', data);
    if (this.ws?.readyState === WS.OPEN) this.ws.send(data);
    else console.error('Cannot send to gateway: not connected');
  }

  scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    console.log(`Reconnecting to gateway in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    setTimeout(() => this.connect(), delay);
  }

  addBrowserClient(ws) {
    this.browserClients.set(ws, { activeWorkspace: null, activeThreadId: null });
    if (ws.readyState === WS.OPEN) {
      ws.send(JSON.stringify({ type: 'clawchats', event: 'gateway-status', connected: this.connected }));
      const streams = [];
      for (const [sessionKey, state] of this.streamState.entries()) {
        if (state.state === 'streaming' && !(state.held?.length > 0)) {
          const parsed = parseSessionKey(sessionKey);
          // Include both old shape (sessionKey/buffer) and new shape (workspace/content) for dual-emit compat
          streams.push({ sessionKey, threadId: state.threadId, buffer: state.buffer, ...(parsed ? { workspace: parsed.workspace, content: state.buffer } : {}) });
        }
      }
      if (streams.length > 0) ws.send(JSON.stringify({ type: 'clawchats', event: 'stream-sync', streams }));
    }
  }

  removeBrowserClient(ws) { this.browserClients.delete(ws); }

  setActiveThread(ws, workspace, threadId) {
    const client = ws ? this.browserClients.get(ws) : null;
    if (client) { client.activeWorkspace = workspace; client.activeThreadId = threadId; }
    if (!workspace || !threadId) return;
    try {
      const wsData = this.getWorkspaces();
      if (!wsData.workspaces[workspace]) return;
      const db = this.getDb(workspace);
      if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId)) return;
      const deleted = db.prepare('DELETE FROM unread_messages WHERE thread_id = ?').run(threadId);
      if (deleted.changes > 0) {
        syncThreadUnreadCount(db, threadId);
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'unread-update', workspace, threadId, action: 'clear', unreadCount: 0, workspaceUnreadTotal: db.prepare('SELECT COALESCE(SUM(unread_count), 0) as total FROM threads').get().total, timestamp: Date.now() }));
      }
    } catch (e) { console.error('Failed to auto-clear unreads on active-thread:', e.message); }
  }

  addBroadcastTarget(fn) { this._externalBroadcastTargets.push(fn); }
  removeBroadcastTarget(fn) { this._externalBroadcastTargets = this._externalBroadcastTargets.filter(f => f !== fn); }
}
