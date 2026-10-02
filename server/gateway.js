import path from 'node:path';
import { WebSocket as WS } from 'ws';
import { loadOrCreateDeviceIdentity, buildDeviceAuth } from './bootstrap/identity.js';
import { parseSessionKey, extractContent, isSilentReplyExact, isSilentReplyPrefix, sanitizeAssistantContent, syncThreadUnreadCount, generateActivitySummary, writeActivityToDb } from './util/helpers.js';

/**
 * Cumulative assistant text for a `chat` delta event.
 * Protocol-v4 gateways (2026.9+) send appends in `deltaText`; only the first frame of a
 * run (and any new baseline) carries the full `message` snapshot, which already includes
 * the delta. `replace: true` makes `deltaText` the entire text. Older gateways send the
 * full cumulative `message` on every delta, which the snapshot branch covers.
 */
export function nextChatText(prev, params) {
  if (params?.message) return extractContent(params.message);
  if (typeof params?.deltaText !== 'string') return prev || '';
  return params.replace ? params.deltaText : (prev || '') + params.deltaText;
}

// Per-session run/transcript events; hidden sessions' ones are dropped by the lens.
const RUN_EVENTS = new Set(['chat', 'agent', 'session.tool', 'session.operation', 'session.observer']);

export class GatewayClient {
  constructor({ getDb, getWorkspaces, dataDir, debugLogger, gatewayWsUrl, authToken }) {
    this.getDb = getDb;
    this.getWorkspaces = getWorkspaces;
    this.dataDir = dataDir;
    this.debugLogger = debugLogger;
    this.gatewayWsUrl = gatewayWsUrl;
    this.authToken = authToken;
    // Per-session buffer of attachment paths captured during a run. Drained by saveAssistantMessage.
    // Sources: (1) MEDIA: paths from exec tool's echo args, (2) Write/Edit tool args.path.
    // Lives on the stable singleton — safe from plugin re-registration that broke the old closure-based stash.
    // LEGACY(gateway-native): this._runMediaPaths = new Map();
    // Per-toolCallId staging for Write/Edit: path captured at phase:start, promoted to _runMediaPaths
    // at phase:result if the call succeeded. Keyed by toolCallId; value: { sessionKey, path }.
    // LEGACY(gateway-native): this._runWriteBuffers = new Map();

    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.browserClients = new Map();
    this._externalBroadcastTargets = [];
    this.streamState = new Map();
    this._utilityText = new Map(); // sessionKey → accumulated delta text for utility sessions
    this._rpc = new Map(); // request id → { resolve, reject, timer } for connector-originated RPCs
    this._rpcSeq = 0;
    this.activityLogs = new Map();
    this._pendingTitleGens = new Map();
    // Runs we've already synthesized a streaming-end{reason:'error'} for
    // (agent lifecycle:error emitted but no chat state:error ever will). Prevents
    // double-fires across retries and cross-path dedup with handleChatEvent.
    this._syntheticErrorRuns = new Set();

    // Runs that already delivered a reply the user can see (persisted + broadcast).
    // The gateway may report a run-level fault AFTER the reply is delivered — a retried
    // tool call, or a post_turn/gateway_draining fault (see OpenClaw's
    // AGENT_RUN_TERMINAL_RETRY_GRACE_MS deferral). Those describe the run, not the reply,
    // and must never overwrite a message the user already read. Keyed by runId because
    // sessionKey is stable for the whole thread — a late error from turn N must not be
    // confused with a live error from turn N+1. Mirrors the OCPlatform TUI's
    // finalizedRunsWithDisplay guard.
    this._runsWithDeliveredReply = new Set();

    // ── LEGACY(gateway-native) BEGIN: stale pending rows in ClawChats DBs
    // // On startup: mark any pending activity log messages from previous crashed/restarted sessions
    // // as interrupted. Without this, stale pending=true rows survive gateway restarts and cause
    // // phantom "thinking..." indicators in the browser on reconnect.
    // try {
      // const workspaces = this.getWorkspaces();
      // for (const wsName of Object.keys(workspaces.workspaces || {})) {
        // const db = this.getDb(wsName);
        // if (db) db.prepare(`UPDATE messages SET content = '[Response interrupted]', metadata = json_remove(metadata, '$.pending') WHERE content = '' AND json_extract(metadata, '$.pending') = 1`).run();
      // }
    // } catch (e) { console.log('[clawchats] startup pending cleanup skipped:', e.message); }
    // ── LEGACY(gateway-native) END

    // Periodically clean up stale activity logs (>10 min old)
    setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [runId, log] of this.activityLogs) {
        if (log.startTime < cutoff) {
          // ── LEGACY(gateway-native) BEGIN: DB pending row cleanup
          // if (log._messageId) {
            // const db = this.getDb(log._parsed?.workspace);
            // if (db) db.prepare(`UPDATE messages SET content = '[Response interrupted]', metadata = json_remove(metadata, '$.pending') WHERE id = ? AND content = ''`).run(log._messageId);
          // }
          // ── LEGACY(gateway-native) END
          this.activityLogs.delete(runId);
        }
      }
    }, 5 * 60 * 1000);
  }

  /** parseSessionKey, but following threads that sync moved to another project. */
  _locate(sessionKey) {
    const loc = this.sync ? this.sync.locate(sessionKey) : parseSessionKey(sessionKey);
    if (loc) return loc;
    // Gateway-native chat (agent:<id>:dashboard:<id>): no ClawChats DB row. Stream shaping
    // (streaming-delta/end, activity) still runs, keyed by the session key; `workspace`
    // is null, so every DB write path skips it.
    if (this.lens?.isVisible(sessionKey)) return { agent: sessionKey.split(':')[1], workspace: null, threadId: sessionKey, gatewayNative: true };
    return null;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WS.CONNECTING || this.ws.readyState === WS.OPEN)) return;
    console.log(`Connecting to gateway at ${this.gatewayWsUrl}...`);
    this.ws = new WS(this.gatewayWsUrl);
    this.ws.on('open', () => { console.log('Gateway WebSocket connected'); this.reconnectAttempts = 0; });
    this.ws.on('message', data => this.handleGatewayMessage(data.toString()));
    this.ws.on('close', () => { console.log('Gateway WebSocket closed'); this.connected = false; this._failPendingRpcs('gateway disconnected'); this.lens?.reset(); this.broadcastGatewayStatus(false); this.scheduleReconnect(); });
    this.ws.on('error', err => console.error('Gateway WebSocket error:', err.message));
  }

  handleGatewayMessage(data) {
    this.debugLogger.logFrame('GW→SRV', data);
    let msg;
    try { msg = JSON.parse(data); } catch { console.error('Invalid JSON from gateway:', data); return; }

    // Responses to the connector's own RPCs (request()) are not browser traffic.
    if (msg.type === 'res' && this._rpc.has(msg.id)) {
      const pending = this._rpc.get(msg.id);
      this._rpc.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.payload);
      else pending.reject(new Error(msg.error?.message || `${pending.method} failed`));
      return;
    }

    // Responses to browser session requests the lens filters (roster, search, groups).
    if (msg.type === 'res' && this.lens?.ownsResponse(msg.id)) {
      this.broadcastToBrowsers(JSON.stringify(this.lens.response(msg)));
      return;
    }

    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const identity = loadOrCreateDeviceIdentity(path.join(this.dataDir, 'device-identity.json'));
      const device = buildDeviceAuth(identity, { clientId: 'gateway-client', clientMode: 'backend', role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], token: this.authToken, nonce: msg.payload?.nonce || '' });
      this.ws.send(JSON.stringify({ type: 'req', id: 'gw-connect-1', method: 'connect', params: { minProtocol: 3, maxProtocol: 4, client: { id: 'gateway-client', version: '0.1.0', platform: 'node', mode: 'backend' }, role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], device, auth: { token: this.authToken }, caps: ['tool-events'] } }));
      return;
    }
    if (msg.type === 'res' && msg.payload?.type === 'hello-ok') { console.log('Gateway handshake complete'); this.connected = true; this.broadcastGatewayStatus(true); this.sync?.onConnected(); this.request('sessions.subscribe', {}).catch(e => console.warn(`[lens] sessions.subscribe failed: ${e.message}`)); this.lens?.seed().catch(e => console.warn(`[lens] seed failed: ${e.message}`)); }
    // Session events arrive through the connector's own subscription; the lens filters them
    // for the browser (session.message only for chats a browser subscribed to).
    if (msg.type === 'event' && (msg.event === 'sessions.changed' || msg.event === 'session.message')) {
      if (msg.event === 'sessions.changed') this.sync?.onSessionsChanged(msg.payload);
      const frame = msg.event === 'sessions.changed' ? this.lens?.sessionsChanged(msg.payload) : this.lens?.sessionMessage(msg.payload);
      if (frame) this.broadcastToBrowsers(JSON.stringify(frame));
      return;
    }
    // Run events of sessions ClawChats doesn't show (channels, cron, subagents) never
    // leave the connector.
    if (msg.type === 'event' && RUN_EVENTS.has(msg.event) && this.lens && msg.payload?.sessionKey && !this.lens.forwardsRunEvent(msg.payload.sessionKey)) {
      return;
    }
    if (msg.type === 'event' && msg.event === 'chat' && msg.payload) {
      // LEGACY(gateway-native): connector-side stream shaping (streaming-delta/reset/end, activity-updated,
      // utility-response). The browser builds live runs from raw events (frontend/live-run.js).
      // this.handleChatEvent(msg.payload, data);
      this.broadcastToBrowsers(data);
    } else {
      this.broadcastToBrowsers(data);
    }
    // LEGACY(gateway-native): if (msg.type === 'event' && msg.event === 'agent' && msg.payload) this.handleAgentEvent(msg.payload);
  }

  handleChatEvent(params, rawData) {
    const { sessionKey, state, message, seq, runId, errorMessage: gwErrorMessage } = params;
    const bareSessionKey = sessionKey.replace(/^agent:[^:]+:/, '');

    // --- Utility session routing (connector-side) ---
    // Emits semantic utility-response events. Also forwards rawData for dual-emit compatibility
    // during transition — browser handleChatEvent guards these and defers to utility-response handler.
    const UTILITY_SESSIONS = { '__clawchats_summarizer': 'summarizer', '__clawchats_semantic': 'semantic', '__clawchats_intelligence': 'intelligence' };
    const utilityName = UTILITY_SESSIONS[bareSessionKey];
    if (utilityName) {
      const content = state === 'delta' ? this._accumulateChatText(sessionKey, params) : extractContent(message);
      if (state !== 'delta') this._utilityText.delete(sessionKey);
      if (state === 'delta' && content) {
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'utility-response', session: utilityName, state: 'delta', content }));
      } else if (state === 'final' || state === 'aborted') {
        if (content) this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'utility-response', session: utilityName, state: state === 'final' ? 'final' : 'aborted', content }));
      } else if (state === 'error') {
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'utility-response', session: utilityName, state: 'error', errorMessage: gwErrorMessage || message?.error || message?.content || 'Unknown error' }));
      }
      this.broadcastToBrowsers(rawData); // dual-emit: browser guard skips raw handling for utility sessions
      return;
    }

    // --- Delta path ---
    if (state === 'delta') {
      const parsed = this._locate(sessionKey);
      if (parsed) {
        const existing = this.streamState.get(sessionKey) || { buffer: '', threadId: parsed.threadId, state: 'streaming', held: [] };
        const prevLen = existing.buffer.length; // capture before update — used to advance thoughtStartOffset on first post-tool delta
        const prevBuffer = existing.buffer;
        existing.buffer = nextChatText(existing.buffer, params);
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
        // On the first delta after a tool result, advance the segment offset and signal the
        // frontend to clear the bubble. Both happen here — right before the new-segment delta —
        // so the clear and fill are atomic from the browser's perspective.
        if (existing.pendingReset) {
          // A v4 gateway may open the post-tool segment with a fresh snapshot instead of
          // extending the run text; only skip the old text if it's still a prefix.
          existing.thoughtStartOffset = existing.buffer.startsWith(prevBuffer) ? prevLen : 0;
          existing.pendingReset = false;
          this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-reset', threadId: parsed.threadId, workspace: parsed.workspace }));
        }
        // Broadcast only the current-segment portion (text after the last tool call offset).
        // thoughtStartOffset advances on first post-tool delta; 0 means no tools yet → full buffer.
        const visibleContent = existing.buffer.substring(existing.thoughtStartOffset || 0);
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-delta', threadId: parsed.threadId, workspace: parsed.workspace, content: visibleContent }));
      } else {
        this.broadcastToBrowsers(rawData); // non-clawchats session (discord, telegram, etc.)
      }
      return;
    }

    // --- End states ---
    const streamEntry = this.streamState.get(sessionKey);
    if (state === 'final' || state === 'aborted' || state === 'error') this.streamState.delete(sessionKey);

    // ── LEGACY(gateway-native) BEGIN: ClawChats title sessions (gateway auto-titles)
    // // Title sessions are handled server-side — intercept and skip browser delivery
    // if (sessionKey?.includes('__clawchats_title_')) {
      // if (state === 'final') {
        // const content = extractContent(message);
        // const handled = content && this.handleTitleResponse(sessionKey, content);
        // if (this.sync) this.sync.run(() => this.sync.deleteSession(sessionKey)).catch(e => console.warn(`[clawchats] title session cleanup: ${e.message}`));
        // if (handled) return;
      // }
      // else if (state === 'error' || state === 'aborted') { for (const key of this._pendingTitleGens.keys()) { if (sessionKey === key || sessionKey.includes(key)) { this._pendingTitleGens.delete(key); break; } } return; }
      // return;
    // }
    // ── LEGACY(gateway-native) END

    if (state === 'final') {
      const rawContent = extractContent(message);
      const parsed = this._locate(sessionKey);
      if (isSilentReplyExact(rawContent, 'NO_REPLY') || isSilentReplyExact(rawContent, 'HEARTBEAT_OK')) {
        this._cleanupSilentPending(sessionKey);
        if (parsed) this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-end', threadId: parsed.threadId, workspace: parsed.workspace, reason: 'silent' }));
        return;
      }
      if (streamEntry?.held?.length > 0) for (const h of streamEntry.held) this.broadcastToBrowsers(h);
      const delivered = this.saveAssistantMessage(sessionKey, message, seq, streamEntry?.thoughtStartOffset) || !!sanitizeAssistantContent(extractContent(message))?.trim(); // persist + broadcast message-saved first
      if (delivered && runId) this._runsWithDeliveredReply.add(runId);
      this.broadcastToBrowsers(rawData);                   // dual-emit: raw final event
      if (parsed) {
        const activity = this._popActivityLogForSession(sessionKey);
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-end', threadId: parsed.threadId, workspace: parsed.workspace, reason: 'complete', ...(activity || {}) }));
      }
      return;
    }
    if (state === 'aborted') {
      const parsed = this._locate(sessionKey);
      // Clear pending flag from DB so a stale pending:true doesn't survive page reloads
      // and trigger phantom "thinking..." state on next visit to this thread.
      if (parsed?.workspace) {
        const db = this.getDb(parsed.workspace);
        if (db) this._clearPendingFlag(db, parsed.threadId);
      }
      this.broadcastToBrowsers(rawData); // dual-emit
      if (parsed) {
        const activity = this._popActivityLogForSession(sessionKey);
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-end', threadId: parsed.threadId, workspace: parsed.workspace, reason: 'aborted', ...(activity || {}) }));
      }
    } else if (state === 'error') {
      // Late run-level fault for a run that already delivered its reply — drop it.
      // Emitting streaming-end{reason:'error'} here makes the browser replace the
      // rendered answer with an error bubble, destroying a message the user already read.
      if (runId && this._runsWithDeliveredReply.has(runId)) {
        console.log(`[clawchats] ignoring late error for run ${runId} — reply already delivered`);
        return;
      }
      const parsed = this._locate(sessionKey);
      this.saveErrorMarker(sessionKey, message);
      this.broadcastToBrowsers(rawData); // dual-emit
      if (parsed) {
        const activity = this._popActivityLogForSession(sessionKey);
        this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'streaming-end', threadId: parsed.threadId, workspace: parsed.workspace, reason: 'error', errorMessage: gwErrorMessage || message?.error || message?.content || 'Unknown error', ...(activity || {}) }));
      }
    }
  }

  // Gateway RPC from the connector itself; resolves with the response payload.
  request(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws || this.ws.readyState !== 1) return reject(new Error('gateway not connected'));
      const id = `cc-rpc-${++this._rpcSeq}`;
      const timer = setTimeout(() => { this._rpc.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this._rpc.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  _failPendingRpcs(reason) {
    for (const [id, p] of this._rpc) { clearTimeout(p.timer); p.reject(new Error(reason)); this._rpc.delete(id); }
  }

  // Utility sessions keep no streamState entry; accumulate their delta text separately.
  _accumulateChatText(sessionKey, params) {
    const text = nextChatText(this._utilityText.get(sessionKey) || '', params);
    this._utilityText.set(sessionKey, text);
    return text;
  }

  // Removes metadata.pending flag from any pending assistant message for a thread.
  // Called on abort and by _cleanupSilentPending — keeps the SQL in one place.
  _clearPendingFlag(db, threadId) {
    // LEGACY(gateway-native): no-op stub (gateway owns this now); delete together with its callers.
    // ── LEGACY(gateway-native) BEGIN: original body
    // db.prepare(
    //   "UPDATE messages SET metadata = json_remove(metadata, '$.pending') " +
    //   "WHERE thread_id = ? AND role = 'assistant' AND json_extract(metadata, '$.pending') = 1"
    // ).run(threadId);
    // ── LEGACY(gateway-native) END
  }

  _cleanupSilentPending(sessionKey) {
    // LEGACY(gateway-native): no-op stub (gateway owns this now); delete together with its callers.
    // ── LEGACY(gateway-native) BEGIN: original body
    // const parsed = this._locate(sessionKey);
    // if (!parsed) return;
    // const ws = this.getWorkspaces();
    // if (!ws.workspaces[parsed.workspace]) return;
    // const db = this.getDb(parsed.workspace);
    // if (!db) return;
    // const result = db.prepare(`DELETE FROM messages WHERE thread_id = ? AND role = 'assistant' AND json_extract(metadata, '$.pending') = 1`).run(parsed.threadId);
    // if (result.changes > 0) console.log(`[clawchats] silent-reply cleanup: removed ${result.changes} pending message(s) for ${parsed.threadId}`);
    // // Caller broadcasts streaming-end { reason: 'silent' } — no event emitted here.
    // ── LEGACY(gateway-native) END
  }

  // Returns true when a reply was actually persisted for this run, false on every
  // early-out. handleChatEvent uses the result to decide whether the run counts as
  // having delivered a visible reply.
  saveAssistantMessage(sessionKey, message, seq, thoughtStartOffset = 0) {
    // LEGACY(gateway-native): no-op stub (gateway owns this now); delete together with its callers.
    return false;
    // ── LEGACY(gateway-native) BEGIN: original body
    // const parsed = this._locate(sessionKey);
    // if (!parsed?.workspace) return false; // gateway-native chats: the gateway owns the transcript
    // const ws = this.getWorkspaces();
    // if (!ws.workspaces[parsed.workspace]) { console.log(`Ignoring response for deleted workspace: ${parsed.workspace}`); return false; }
    // const db = this.getDb(parsed.workspace);
    // if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(parsed.threadId)) { console.log(`Ignoring response for deleted thread: ${parsed.threadId}`); return false; }

    // // Trim to final-answer portion: only text after the last tool call offset.
    // // thoughtStartOffset is passed in from handleChatEvent (captured before streamState.delete).
    // // Intermediate narration lives in activityLog steps; message.content is the clean final answer.
    // const fullContent = extractContent(message);
    // // Never let a stale segment offset blank the reply (v4 snapshots can be shorter).
    // if (thoughtStartOffset > fullContent.length) thoughtStartOffset = 0;
    // let content = sanitizeAssistantContent(fullContent.substring(thoughtStartOffset));

    // // Attach media (MEDIA: paths extracted from exec tool args by handleAgentEvent).
    // // Buffer is read before the empty-content guard — media-only responses (no text) must not be dropped.
    // const pendingPaths = this._runMediaPaths.get(sessionKey) ?? [];
    // this._runMediaPaths.delete(sessionKey);
    // const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','bmp','svg','ico','avif','tiff']);
    // const AUDIO_EXTS = new Set(['mp3','wav','ogg','m4a','flac','aac','opus','wma']);
    // const imagePaths = [], pendingAttachments = [];
    // for (const p of pendingPaths) {
    //   const ext = (p.split('.').pop() || '').toLowerCase();
    //   if (IMAGE_EXTS.has(ext)) imagePaths.push(p);
    //   else pendingAttachments.push({ path: p, name: p.split('/').pop(), type: AUDIO_EXTS.has(ext) ? 'audio' : 'file' });
    // }
    // if (imagePaths.length > 0) content = (content?.trimEnd() || '') + '\n\n' + imagePaths.map(p => `![image](${p})`).join('\n');
    // if (pendingPaths.length > 0) console.log(`[clawchats] media-attach: ${imagePaths.length} image(s), ${pendingAttachments.length} attachment(s) for ${sessionKey}`);

    // const now = Date.now();
    // const pendingMsg = db.prepare(`SELECT id, metadata FROM messages WHERE thread_id = ? AND role = 'assistant' AND json_extract(metadata, '$.pending') = 1 ORDER BY timestamp DESC LIMIT 1`).get(parsed.threadId);

    // // Skip only if there is truly nothing to save AND no pending row to resolve.
    // // If a pending row exists, always proceed to update it (even with empty content) so the
    // // pending flag is cleared. Without this, tool-only responses (no post-tool text) leave
    // // pending=true forever, and the startup cleanup marks them '[Response interrupted]'.
    // if (!content?.trim() && pendingPaths.length === 0 && !pendingMsg) { console.log(`Skipping empty assistant response for thread ${parsed.threadId}`); return false; }
    // let messageId;

    // if (pendingMsg) {
    //   const metadata = pendingMsg.metadata ? JSON.parse(pendingMsg.metadata) : {};
    //   delete metadata.pending;
    //   if (metadata.activityLog) { const idx = metadata.activityLog.findLastIndex(s => s.type === 'assistant'); if (idx >= 0) metadata.activityLog.splice(idx, 1); metadata.activitySummary = generateActivitySummary(metadata.activityLog); }
    //   if (pendingAttachments.length > 0) metadata.attachments = [...(metadata.attachments || []), ...pendingAttachments];
    //   db.prepare('UPDATE messages SET content = ?, metadata = ?, timestamp = ? WHERE id = ?').run(content, JSON.stringify(metadata), now, pendingMsg.id);
    //   messageId = pendingMsg.id;
    // } else {
    //   messageId = seq != null ? `gw-${parsed.threadId}-${seq}` : `gw-${parsed.threadId}-${now}`;
    //   const newMeta = pendingAttachments.length > 0 ? JSON.stringify({ attachments: pendingAttachments }) : null;
    //   db.prepare(`INSERT INTO messages (id, thread_id, role, content, status, metadata, timestamp, created_at) VALUES (?, ?, 'assistant', ?, 'sent', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, metadata = COALESCE(excluded.metadata, metadata), timestamp = excluded.timestamp`).run(messageId, parsed.threadId, content, newMeta, now, now);
    // }

    // try {
    //   db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, parsed.threadId);
    //   db.prepare('INSERT OR IGNORE INTO unread_messages (thread_id, message_id, created_at) VALUES (?, ?, ?)').run(parsed.threadId, messageId, now);
    //   syncThreadUnreadCount(db, parsed.threadId);
    //   const threadInfo = db.prepare('SELECT title FROM threads WHERE id = ?').get(parsed.threadId);
    //   const unreadCount = db.prepare('SELECT COUNT(*) as c FROM unread_messages WHERE thread_id = ?').get(parsed.threadId).c;
    //   const preview = content.length > 120 ? content.substring(0, 120) + '...' : content;
    //   this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'message-saved', threadId: parsed.threadId, workspace: parsed.workspace, messageId, timestamp: now, title: threadInfo?.title, preview, unreadCount, updatedContent: imagePaths.length > 0 ? content : undefined, updatedAttachments: pendingAttachments.length > 0 ? pendingAttachments : undefined }));
    //   this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'unread-update', workspace: parsed.workspace, threadId: parsed.threadId, messageId, action: 'new', unreadCount, workspaceUnreadTotal: db.prepare('SELECT COALESCE(SUM(unread_count), 0) as total FROM threads').get().total, title: threadInfo?.title, preview, timestamp: now }));
    //   console.log(`Saved assistant message to ${parsed.workspace}/${parsed.threadId} (${pendingMsg ? 'merged into pending' : 'seq: ' + seq})`);
    //   const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE thread_id = ?').get(parsed.threadId).c;
    //   if (msgCount === 2 || threadInfo?.title === 'New chat') this.generateThreadTitle(db, parsed.threadId, parsed.workspace, true);
    // } catch (e) { console.error('Failed to save assistant message:', e.message); }
    // // The message row is written above the try block, so it is persisted even if the
    // // follow-up bookkeeping/broadcast throws — the reply was delivered either way.
    // return true;
    // ── LEGACY(gateway-native) END
  }

  saveErrorMarker(sessionKey, message) {
    // LEGACY(gateway-native): no-op stub (gateway owns this now); delete together with its callers.
    // ── LEGACY(gateway-native) BEGIN: original body
    // const parsed = this._locate(sessionKey);
    // if (!parsed) return;
    // const ws = this.getWorkspaces();
    // if (!ws.workspaces[parsed.workspace]) return;
    // const db = this.getDb(parsed.workspace);
    // if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(parsed.threadId)) return;
    // const now = Date.now();
    // try {
    //   db.prepare('INSERT INTO messages (id, thread_id, role, content, status, metadata, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(`gw-error-${parsed.threadId}-${now}`, parsed.threadId, 'system', `[error] ${message?.error || message?.content || 'Unknown error'}`, 'sent', '{"transient":true}', now, now);
    //   // Clear stale pending flag so browsers reloading the chat don't re-derive "thinking..." state.
    //   db.prepare("UPDATE messages SET metadata = json_remove(metadata, '$.pending') WHERE thread_id = ? AND role = 'assistant' AND json_extract(metadata, '$.pending') = 1").run(parsed.threadId);
    // } catch (e) { console.error('Failed to save error marker:', e.message); }
    // ── LEGACY(gateway-native) END
  }

  generateThreadTitle(db, threadId, workspace, skipHeuristic = false) {
    // LEGACY(gateway-native): no-op stub (gateway owns this now); delete together with its callers.
    // ── LEGACY(gateway-native) BEGIN: original body
    // if (!db.prepare('SELECT title FROM threads WHERE id = ?').get(threadId)) return;
    // const titleKey = `__clawchats_title_${threadId}`;
    // if (this._pendingTitleGens.has(titleKey)) return;
    // const firstUserMsg = db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1").get(threadId);
    // if (!firstUserMsg?.content) return;
    // if (!skipHeuristic) {
    //   const heuristic = firstUserMsg.content.replace(/\n.*/s, '').slice(0, 40).trim() + (firstUserMsg.content.length > 40 ? '...' : '');
    //   db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(heuristic, threadId);
    //   this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'thread-title-updated', threadId, workspace, title: heuristic }));
    //   this._syncTitle(db, workspace, threadId, heuristic);
    // }
    // const messages = db.prepare('SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT 6').all(threadId);
    // if (messages.length < 2) return;
    // const conversation = messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content}`).join('\n\n');
    // const reqId = `title-${threadId}-${Date.now()}`;
    // this._pendingTitleGens.set(titleKey, { threadId, workspace, reqId });
    // setTimeout(() => { if (this._pendingTitleGens.has(titleKey)) { this._pendingTitleGens.delete(titleKey); console.log(`Title gen timeout for ${threadId}`); } }, 30000);
    // this.sendToGateway(JSON.stringify({ type: 'req', id: reqId, method: 'chat.send', params: { sessionKey: titleKey, message: `Based on this conversation, generate a concise 3-5 word title. Return ONLY the title text, no quotes, no explanation:\n\n${conversation}\n\nTitle:`, deliver: false, idempotencyKey: reqId } }));
    // ── LEGACY(gateway-native) END
  }

  handleTitleResponse(sessionKey, content) {
    // LEGACY(gateway-native): no-op stub (gateway owns this now); delete together with its callers.
    return false;
    // ── LEGACY(gateway-native) BEGIN: original body
    // let matchKey = null, pending = null;
    // for (const [key, val] of this._pendingTitleGens) {
    //   if (sessionKey === key || sessionKey.includes(key)) { matchKey = key; pending = val; break; }
    // }
    // if (!pending) return false;
    // this._pendingTitleGens.delete(matchKey);
    // let title = content.trim().replace(/^["']|["']$/g, '').replace(/^Title:\s*/i, '').replace(/\n.*/s, '').trim();
    // if (title.length > 50) title = title.substring(0, 47) + '...';
    // if (!title || title.length >= 100) return true;
    // const db = this.getDb(pending.workspace);
    // db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, pending.threadId);
    // this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'thread-title-updated', threadId: pending.threadId, workspace: pending.workspace, title }));
    // console.log(`AI title generated for ${pending.threadId}: "${title}"`);
    // this._syncTitle(db, pending.workspace, pending.threadId, title);
    // return true;
    // ── LEGACY(gateway-native) END
  }

  // Copy a generated title to the gateway session's custom name; the throwaway
  // title-generation session is deleted once its answer is in.
  _syncTitle(db, workspace, threadId, title) {
    // LEGACY(gateway-native): no-op stub (gateway owns this now); delete together with its callers.
    // ── LEGACY(gateway-native) BEGIN: original body
    // if (!this.sync) return;
    // const row = db.prepare('SELECT session_key FROM threads WHERE id = ?').get(threadId);
    // if (row?.session_key) this.sync.titleGenerated(workspace, threadId, row.session_key, title);
    // ── LEGACY(gateway-native) END
  }

  handleAgentEvent(payload) {
    const { runId, stream, data, sessionKey } = payload;
    if (!runId) return;
    if (!this.activityLogs.has(runId)) this.activityLogs.set(runId, { sessionKey, steps: [], startTime: Date.now() });
    const log = this.activityLogs.get(runId);
    if (!log._parsed && sessionKey) log._parsed = this._locate(sessionKey);

    if (stream === 'thinking') {
      let step = log.steps.find(s => s.type === 'thinking');
      if (step) step.text = data?.text || '';
      else log.steps.push({ type: 'thinking', timestamp: Date.now(), text: data?.text || '' });
      // LEGACY(gateway-native): activity rows in ClawChats DBs — writeActivityToDb(this.getDb, this.broadcastToBrowsers.bind(this), runId, log);
      const now = Date.now();
      if (!log._lastThinkingBroadcast || now - log._lastThinkingBroadcast >= 300) { log._lastThinkingBroadcast = now; this._broadcastActivityUpdate(runId, log); }
    }
    if (stream === 'tool') {
      // At phase:start the gateway has already flushed the text buffer, so the buffer is
      // complete. Capture the full inter-tool narration now — no race, no stale snapshots.
      // For result/update phases, just defensively seal any still-open segment.
      if (data?.phase !== 'result' && data?.phase !== 'update') {
        const streamEntry = this.streamState.get(sessionKey);
        const narrationStart = log._lastNarrationStart ?? 0;
        const narrationText = streamEntry ? streamEntry.buffer.substring(narrationStart) : '';
        if (log._currentAssistantSegment && !log._currentAssistantSegment._sealed) {
          if (narrationText.trim()) log._currentAssistantSegment.text = narrationText;
          log._currentAssistantSegment._sealed = true;
        } else if (narrationText.trim()) {
          const seg = { type: 'assistant', timestamp: Date.now(), text: narrationText, _sealed: true };
          log._currentAssistantSegment = seg;
          log.steps.push(seg);
        }
      } else if (log._currentAssistantSegment && !log._currentAssistantSegment._sealed) {
        log._currentAssistantSegment._sealed = true;
      }
      const argsMeta = data?.args ? (data.args.command || data.args.path || data.args.query || data.args.url || Object.values(data.args).find(v => typeof v === 'string') || '') : '';
      // ── LEGACY(gateway-native) BEGIN: MEDIA scraping from exec/Write args (gateway parses MEDIA: in replies)
      // // Extract MEDIA: paths from exec tool's echo command at phase:start.
      // // The agent signals inline media with `echo "MEDIA:/absolute/path"` (see plugin's before_prompt_build hint).
      // // Parsing the tool args here keeps state on this stable singleton instead of the plugin's re-registered closure.
      // if (sessionKey && (data?.name === 'exec' || data?.name === 'process') && data?.phase === 'start' && typeof data?.args?.command === 'string') {
        // const paths = [...data.args.command.matchAll(/MEDIA:([^\s"'`]+)/g)].map(m => m[1]).filter(Boolean);
        // if (paths.length > 0) {
          // const existing = this._runMediaPaths.get(sessionKey) ?? [];
          // this._runMediaPaths.set(sessionKey, [...new Set([...existing, ...paths])]);
        // }
      // }
      // // Capture Write/Edit tool paths. The split pane (and existing attachment chip render) handles
      // // any text-ish or PDF file, so allow that broad set; image/audio extensions also flow through
      // // — saveAssistantMessage routes them by ext (image → markdown, audio → audio chip).
      // // Buffer at phase:start when args.path is present; promote to _runMediaPaths at phase:result
      // // only if the call succeeded — failed writes shouldn't surface a chip for a file that may not exist.
      // const VIEWABLE_EXTS = new Set([
        // 'pdf','md','mdx','rst','txt','log',
        // 'csv','tsv','json','xml','yaml','yml','toml','ini','env','conf',
        // 'js','jsx','mjs','cjs','ts','tsx','py','rb','go','rs','java','c','cpp','h','hpp','cs','php',
        // 'html','htm','css','scss','sass','less','sh','bash','zsh','sql','pl','lua','r','swift','kt','dart',
        // 'png','jpg','jpeg','gif','webp','bmp','svg','ico','avif','tiff',
        // 'mp3','wav','ogg','m4a','flac','aac','opus','wma'
      // ]);
      // if (sessionKey && data?.toolCallId && /^(write|edit|multiedit|notebookedit)$/i.test(data?.name || '') && data?.phase === 'start' && typeof data?.args?.path === 'string' && data.args.path.length > 0) {
        // const ext = (data.args.path.split('.').pop() || '').toLowerCase();
        // if (VIEWABLE_EXTS.has(ext)) this._runWriteBuffers.set(data.toolCallId, { sessionKey, path: data.args.path });
      // }
      // if (data?.toolCallId && data?.phase === 'result' && this._runWriteBuffers.has(data.toolCallId)) {
        // const buf = this._runWriteBuffers.get(data.toolCallId);
        // this._runWriteBuffers.delete(data.toolCallId);
        // if (!data.isError && buf.sessionKey === sessionKey) {
          // const existing = this._runMediaPaths.get(buf.sessionKey) ?? [];
          // this._runMediaPaths.set(buf.sessionKey, [...new Set([...existing, buf.path])]);
        // }
      // }
      // ── LEGACY(gateway-native) END
      const step = { type: 'tool', timestamp: Date.now(), name: data?.name || 'unknown', phase: data?.phase || 'start', toolCallId: data?.toolCallId, meta: data?.meta || (argsMeta ? String(argsMeta) : undefined), isError: data?.isError || false };
      if (data?.phase === 'result') {
        const existing = log.steps.findLast(s => s.toolCallId === data.toolCallId && (s.phase === 'start' || s.phase === 'running'));
        if (existing) { existing.phase = 'done'; existing.resultMeta = data?.meta; existing.isError = data?.isError || false; existing.durationMs = Date.now() - existing.timestamp; }
        else { step.phase = 'done'; log.steps.push(step); }
        // Advance the visible content offset to the current buffer end.
        // Future streaming-delta broadcasts and the saved message content start from here,
        // so the response area always shows only the most recent thought / final answer.
        const streamEntry = this.streamState.get(sessionKey);
        if (streamEntry && log._parsed) {
          // Don't advance thoughtStartOffset or broadcast streaming-reset yet.
          // Wait for the first post-tool delta before doing either:
          //   (a) No post-tool text: thoughtStartOffset stays at the current segment start,
          //       bubble retains the last segment text as the final answer.
          //   (b) Post-tool text arrives: delta handler advances the offset and broadcasts
          //       streaming-reset immediately before the first new-segment delta, so the
          //       bubble clears at exactly the right moment.
          streamEntry.pendingReset = true;
          log._lastNarrationStart = streamEntry.buffer.length; // align activity log segments with buffer
        }
      } else if (data?.phase === 'update') {
        const existing = log.steps.findLast(s => s.toolCallId === data.toolCallId);
        if (existing) { if (data?.meta) existing.resultMeta = data.meta; if (data?.isError) existing.isError = true; existing.phase = 'running'; }
      } else log.steps.push(step);
      // LEGACY(gateway-native): activity rows in ClawChats DBs — writeActivityToDb(this.getDb, this.broadcastToBrowsers.bind(this), runId, log);
      this._broadcastActivityUpdate(runId, log);
    }
    if (stream === 'lifecycle' && (data?.phase === 'end' || data?.phase === 'error')) {
      if (log._currentAssistantSegment && !log._currentAssistantSegment._sealed) {
        log._currentAssistantSegment._sealed = true;
      }
      // LEGACY(gateway-native): activity rows in ClawChats DBs — writeActivityToDb(this.getDb, this.broadcastToBrowsers.bind(this), runId, log);
      // Store finalized state — streaming-end (handleChatEvent) will pick it up and carry it
      // as one atomic payload. Do NOT broadcast activity-updated here anymore.
      const cleanSteps = log.steps.map(s => { const c = { ...s }; delete c._sealed; return c; });
      log.finalized = true;
      log.finalSteps = cleanSteps;
      log.finalSummary = generateActivitySummary(log.steps);
      // Note: activityLogs entry is kept until _popActivityLogForSession cleans it up
      //
      // Fallback: if the gateway never emitted any chat.* events for this session
      // (e.g. pre-reply provider error on a non-webchat surface where the chat
      // broadcast is gated off upstream), handleChatEvent won't fire a
      // streaming-end and the UI stays locked on "thinking…" forever. Synthesize
      // one here so the frontend's existing error path (`reason: 'error'`) runs.
      // `!streamState.has(sessionKey)` is also true for a run that finished cleanly (the entry
      // is deleted on every terminal state), so the delivered-reply check is what distinguishes
      // "never produced a reply" from "already delivered one".
      if (data?.phase === 'error' && !this.streamState.has(sessionKey) && !this._syntheticErrorRuns.has(runId) && !this._runsWithDeliveredReply.has(runId)) {
        this._syntheticErrorRuns.add(runId);
        const parsed = this._locate(sessionKey);
        if (parsed) {
          // Mirror the state:'error' path — writeActivityToDb just set metadata.pending=true,
          // and without this the flag survives: loadHistory re-derives has_pending on reconnect,
          // "thinking…" sticks, and sendMessage's isStreaming() guard queues future sends into
          // _pendingSend forever.
          this.saveErrorMarker(sessionKey, { error: data?.error || 'Agent failed before reply' });
          this.broadcastToBrowsers(JSON.stringify({
            type: 'clawchats',
            event: 'streaming-end',
            threadId: parsed.threadId,
            workspace: parsed.workspace,
            reason: 'error',
            errorMessage: data?.error || 'Agent failed before reply',
          }));
        }
        // Bound the set — auto-evict after the retry window so long-lived
        // processes don't leak. 5 min is far longer than any retry chain.
        setTimeout(() => this._syntheticErrorRuns.delete(runId), 5 * 60 * 1000);
      }
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
    if (!log._parsed) return;
    // DB-backed threads use the activity row id; gateway-native chats have no row.
    const messageId = log._messageId || `gw-activity-${runId}`;
    const cleanSteps = log.steps.map(s => { const c = { ...s }; delete c._sealed; return c; });
    this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'activity-updated', workspace: log._parsed.workspace, threadId: log._parsed.threadId, messageId, activityLog: cleanSteps, activitySummary: generateActivitySummary(log.steps) }));
  }

  broadcastToBrowsers(data) {
    this.debugLogger.logFrame('SRV→BR', data);
    for (const client of this.browserClients.keys()) { if (client.readyState === WS.OPEN) client.send(data); }
    for (const fn of this._externalBroadcastTargets) { try { fn(data); } catch { /* target disconnected */ } }
  }

  broadcastGatewayStatus(connected) {
    this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'gateway-status', connected }));
  }

  /** A frame from a browser: the lens may rewrite it or answer it itself. */
  forwardFromBrowser(data) {
    const out = this.lens ? this.lens.outbound(data) : data;
    if (out) this.sendToGateway(out);
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
          const parsed = this._locate(sessionKey);
          // Include both old shape (sessionKey/buffer) and new shape (workspace/content) for dual-emit compat
          streams.push({ sessionKey, threadId: state.threadId, buffer: state.buffer, ...(parsed ? { workspace: parsed.workspace, content: state.buffer.substring(state.thoughtStartOffset || 0) } : {}) });
        }
      }
      // LEGACY(gateway-native): stream-sync replay (history carries in-flight runs now)
      // if (streams.length > 0) ws.send(JSON.stringify({ type: 'clawchats', event: 'stream-sync', streams }));
    }
  }

  removeBrowserClient(ws) { this.browserClients.delete(ws); }

  setActiveThread(ws, workspace, threadId) {
    // LEGACY(gateway-native): no-op stub (gateway owns this now); delete together with its callers.
    const client = ws ? this.browserClients.get(ws) : null;
    if (client) { client.activeWorkspace = workspace; client.activeThreadId = threadId; }
    // ── LEGACY(gateway-native) BEGIN: original body
    // const client = ws ? this.browserClients.get(ws) : null;
    // if (client) { client.activeWorkspace = workspace; client.activeThreadId = threadId; }
    // if (!workspace || !threadId) return;
    // try {
    //   const wsData = this.getWorkspaces();
    //   if (!wsData.workspaces[workspace]) return;
    //   const db = this.getDb(workspace);
    //   if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId)) return;
    //   const deleted = db.prepare('DELETE FROM unread_messages WHERE thread_id = ?').run(threadId);
    //   if (deleted.changes > 0) {
    //     syncThreadUnreadCount(db, threadId);
    //     this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'unread-update', workspace, threadId, action: 'clear', unreadCount: 0, workspaceUnreadTotal: db.prepare('SELECT COALESCE(SUM(unread_count), 0) as total FROM threads').get().total, timestamp: Date.now() }));
    //   }
    // } catch (e) { console.error('Failed to auto-clear unreads on active-thread:', e.message); }
    // ── LEGACY(gateway-native) END
  }

  addBroadcastTarget(fn) { this._externalBroadcastTargets.push(fn); }
  removeBroadcastTarget(fn) { this._externalBroadcastTargets = this._externalBroadcastTargets.filter(f => f !== fn); }
}
