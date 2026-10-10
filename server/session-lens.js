// SessionLens: the one place that decides which gateway sessions are ClawChats threads,
// and the filter between the gateway and the browser for session traffic.
//
// The gateway sends session-list events to every subscribed connection unfiltered, and
// the connector's single gateway connection carries everything (Discord, cron, subagents).
// The lens:
//   - forwards `sessions.changed` only for visible sessions (plus key-less catalog events),
//     with rows trimmed to the fields ClawChats renders;
//   - drops `chat`/`agent` run events of sessions ClawChats doesn't show;
//   - filters/trims the responses to browser-issued `sessions.list|subscribe|search`;
//   - keeps the browser from tearing down the connector's own session subscription;
//   - applies project-style side effects of browser-issued group renames/deletes;
//   - fills `createdAt` on listed rows from `clawchats import-dates` when the gateway has none.
//
// Visible = a root, direct, user chat: `agent:<id>:dashboard:<id>` (gateway-created) or
// `agent:<id>:<project>:chat:<id>` (legacy ClawChats). Everything else is hidden.
// Team chat working sessions (server/team.js) are hidden too, but their run events are
// forwarded: the room shows each agent's reply streaming.
//
// Spawned children (sessions_spawn: hidden `agent:<id>:subagent:<id>` runs and `visible: true`
// dashboard sessions) are visible when their parent chain reaches a visible chat; the browser
// nests them under it (Control UI session tree). Their rows carry `ccParentKey`, the parent the
// lens resolved, so the browser never re-derives the placement rule.

const DASHBOARD_KEY = /^agent:[^:]+:dashboard:[^:]+$/;
const LEGACY_CHAT_KEY = /^agent:[^:]+:[^:]+:chat:[^:]+$/;
const UTILITY_MARK = '__clawchats_';
const MAIN_SESSION_KEY = /^agent:[^:]+:main$/;
const SUBAGENT_KEY = /^agent:[^:]+:subagent:[^:]+$/;
const MAX_CHILD_DEPTH = 8;

// Session row fields the browser needs. Anything else stays on the connector side.
export const ROW_FIELDS = new Set([
  'key', 'sessionId', 'agentId', 'kind', 'chatType', 'classification', 'incognito',
  'label', 'autoLabel', 'displayName', 'derivedTitle', 'lastMessagePreview', 'icon', 'color',
  'category', 'pinned', 'pinnedAt', 'archived', 'archivedAt',
  'unread', 'lastReadAt', 'markedUnreadAt',
  'createdAt', 'updatedAt', 'lastActivityAt', 'lastInteractionAt',
  'status', 'hasActiveRun', 'activeRunIds', 'lastRunId', 'lastRunError', 'endedAt', 'agentStatus',
  'model', 'modelProvider', 'thinkingLevel', 'contextTokens', 'totalTokens', 'totalTokensFresh',
  'inputTokens', 'outputTokens', 'permissionMode', 'workspaceDir', 'contextBudgetStatus', 'fastMode', 'effectiveFastMode',
  'startedAt', 'runtimeMs', 'ccParentKey',
]);

// `sessions.changed` envelope fields (snapshot fields are spread next to these).
const EVENT_ENVELOPE = new Set(['sessionKey', 'agentId', 'reason', 'phase', 'ts', 'messageId', 'catalogChanged']);

// Subagent runs are listed: the lens keeps the ones nested under a visible chat.
const LIST_DEFAULTS = { excludeSubagents: false, excludeCron: true, excludeSystem: true };

export function isUtilityKey(key) {
  return typeof key === 'string' && key.includes(UTILITY_MARK);
}

export function isCandidateKey(key) {
  return typeof key === 'string' && !isUtilityKey(key) && (DASHBOARD_KEY.test(key) || LEGACY_CHAT_KEY.test(key));
}

/** Keys that can be a nested child: chat-shaped sessions and subagent runs. */
function isChildCandidateKey(key) {
  return isCandidateKey(key) || (typeof key === 'string' && SUBAGENT_KEY.test(key));
}

/** The parent a hidden row nests under (Control UI resolveUiSessionNavigationParentKey), if any. */
function nestingParent(row) {
  if (row.kind === 'global' || row.kind === 'unknown' || row.kind === 'group') return null;
  const parent = row.parentSessionKey || row.spawnedBy;
  return typeof parent === 'string' && parent && !MAIN_SESSION_KEY.test(parent) ? parent : null;
}

// ── Visibility: port of the Control UI sidebar rule ──────────────────
// ui/src/components/app-sidebar-session-parent.ts  resolveSidebarSessionParentKey
// ui/src/lib/sessions/navigation.ts                sessionMatchesVisibleSessionScope
// src/shared/session-list-visibility.ts            isSystemCreatedSessionRow
// plus the ClawChats scope (no group conversations, no coding sessions, see grouping.ts).
// The Control UI ignores `classification`; so do we.

function hasName(row) {
  return [row.label, row.displayName, row.subject].some(v => typeof v === 'string' && v.trim());
}

/** isSystemCreatedSessionRow (cron keys never reach here: not candidate-shaped). */
function isSystemCreated(row) {
  if (row.classification === 'hb_signal') return !hasName(row);
  if (row.createdActor?.type === 'system') return true;
  if (row.createdVia !== 'run' && row.createdVia !== 'internal') return false;
  if (row.createdActor?.type === 'human') return false;
  return !hasName(row);
}

/**
 * true = hidden, false = visible, null = undecided (partial event snapshot).
 * Full rows (list rows and event snapshots, which always carry `kind`) decide everything;
 * partial rows only decide on facts that can't be outweighed.
 */
export function rowVerdict(row) {
  if (!row || typeof row !== 'object') return null;
  const parent = row.parentSessionKey || row.spawnedBy;
  // Nested children (resolveSidebarSessionParentKey keeps these under their parent).
  // Fork markers only matter together with a parent: a fork of a top-level chat is a
  // top-level chat. ClawChats deviation: forks of main-linked chats (ClawChats edit/regen
  // branches via sessions.fork) stay top level instead of nesting under the main session.
  if (row.spawnedBy) return true;
  if (typeof row.spawnDepth === 'number' && row.spawnDepth > 0) return true;
  // sessions.fork makes the source chat the parent (Control UI nests it there). ClawChats has
  // no nesting and shows edit/regenerate branches as their own chats: a fork whose parent is
  // the chat it was forked from counts as a top-level chat.
  const forkOfChat = !!(row.parentSessionKey && row.forkSource?.sessionKey === row.parentSessionKey && isCandidateKey(row.parentSessionKey));
  if (forkOfChat) return 'kind' in row ? (row.kind === 'global' || row.kind === 'unknown' || row.kind === 'group' || !!row.worktree || !!row.execNode) : null;
  if (parent && !MAIN_SESSION_KEY.test(parent)) return true;
  // Out of the visible scope, or outside ClawChats' scope (Groups / Coding zones).
  if (row.kind === 'global' || row.kind === 'unknown' || row.kind === 'group') return true;
  if (row.worktree || row.execNode) return true;
  if (!('kind' in row)) return null;
  if (isSystemCreated(row)) return true;
  // Main-linked roots are top level only when operator-created (older rows stay nested).
  if (parent && row.createdVia !== 'operator' && !row.forkSource) return true;
  return false;
}

export function trimRow(row) {
  const out = {};
  for (const k of Object.keys(row)) if (ROW_FIELDS.has(k)) out[k] = row[k];
  return out;
}

export function trimEvent(payload) {
  const out = {};
  for (const k of Object.keys(payload)) {
    if (EVENT_ENVELOPE.has(k) || ROW_FIELDS.has(k)) out[k] = payload[k];
  }
  if (payload.session && typeof payload.session === 'object') out.session = trimRow(payload.session);
  return out;
}

export class SessionLens {
  /**
   * @param {object} opts
   * @param {(data: string) => void} opts.broadcast  send a frame to all browsers
   * @param {(method: string, params: object, timeoutMs?: number) => Promise<any>} [opts.request]  connector-originated gateway RPC
   * @param {object} [opts.extras]  ExtrasStore (project style side effects)
   * @param {object} [opts.team]    TeamCoordinator (`isWorkKey`, `onSessionDeleted`)
   */
  constructor({ broadcast, request, extras, team, logger = console }) {
    this.broadcast = broadcast;
    this.request = request;
    this.extras = extras;
    this.team = team;
    this.log = logger;
    this.hidden = new Set(); // candidate-shaped keys a row revealed as not a user chat
    this.parents = new Map(); // child key -> parent key (nested children; visible when the chain reaches a chat)
    this.pending = new Map(); // browser req id -> { method, params }
    // Chats a browser opened with sessions.messages.subscribe (Control UI: one per selected
    // chat). session.message is forwarded only for these. subscriptionId -> session key.
    this.watching = new Map();
  }

  // ── Visibility ──────────────────────────────────────────────────────

  /** Learn from a (possibly partial) row; returns whether the session is visible. */
  observe(key, row) {
    if (!isChildCandidateKey(key)) return false;
    const verdict = SUBAGENT_KEY.test(key) ? true : rowVerdict(row);
    if (verdict === true) {
      this.hidden.add(key);
      const parent = row && typeof row === 'object' && 'kind' in row ? nestingParent(row) : undefined;
      if (parent) this.parents.set(key, parent);
      else if (parent === null) this.parents.delete(key);
    } else if (verdict === false) {
      this.hidden.delete(key);
      this.parents.delete(key);
    }
    return this.isVisible(key);
  }

  isVisible(key) {
    return this._isTopLevel(key) || !!this.parentOf(key);
  }

  _isTopLevel(key) {
    return isCandidateKey(key) && !this.hidden.has(key) && !this.team?.isWorkKey(key);
  }

  /** The parent a visible nested child shows under, or null (not a child, or its chain never reaches a chat). */
  parentOf(key) {
    const parent = this.parents.get(key);
    if (!parent || this.team?.isWorkKey(key)) return null;
    let cur = parent;
    for (let depth = 0; depth < MAX_CHILD_DEPTH; depth++) {
      if (this._isTopLevel(cur)) return parent;
      cur = this.parents.get(cur);
      if (!cur || cur === key) return null;
    }
    return null;
  }

  /** Row/event fields plus the resolved parent link of a nested child. */
  _withParent(key, out) {
    const parent = this.parentOf(key);
    if (parent) out.ccParentKey = parent;
    return out;
  }

  /** chat/agent run events: visible chats, team chat working sessions, utility sessions. */
  forwardsRunEvent(key) {
    return isUtilityKey(key) || this.isVisible(key) || !!this.team?.isWorkKey(key);
  }

  /** Seed `hidden` from a full roster so partial events of child sessions stay hidden. With the
   *  whole roster in hand, also drop ClawChats data (bookmarks etc.) of sessions deleted while
   *  the connector wasn't listening for `sessions.changed`. */
  async seed() {
    if (!this.request) return;
    let offset = 0, rows = 0, complete = false;
    const live = new Set();
    for (let page = 0; page < 50; page++) {
      const res = await this.request('sessions.list', { archived: 'all', limit: 1000, offset }, 60000);
      for (const row of res?.sessions || []) { this.observe(row.key, row); live.add(row.key); rows++; }
      if (!res?.hasMore || res.nextOffset == null) { complete = true; break; }
      offset = res.nextOffset;
    }
    this.log.info?.(`[lens] seeded from ${rows} sessions (${this.hidden.size} hidden chat-shaped)`);
    if (complete && live.size && this.extras?.pruneThreadExtras) {
      const dropped = this.extras.pruneThreadExtras(live);
      if (dropped) {
        this.log.info?.(`[lens] dropped bookmarks/extras of ${dropped} deleted sessions`);
        this.broadcast(JSON.stringify({ type: 'clawchats', event: 'bookmarks-changed' }));
      }
    }
  }

  /** seed(), retried: right after a plugin reload the gateway can briefly fail sessions.list
   *  (PluginInstanceUnavailableError), and a missed seed also skips the extras prune. */
  async seedWithRetry(tries = 4, delayMs = 5000) {
    for (let i = 1; ; i++) {
      try { return await this.seed(); } catch (e) {
        this.log.warn?.(`[lens] seed failed (${i}/${tries}): ${e.message}`);
        if (i >= tries) return;
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  // ── Gateway → browser ───────────────────────────────────────────────

  /** `sessions.changed`. Returns the frame to broadcast, or null to drop. */
  sessionsChanged(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const key = payload.sessionKey;
    if (!key) return { type: 'event', event: 'sessions.changed', payload: trimEvent(payload) }; // catalog/groups
    if (payload.reason === 'delete' && this.team) {
      try { this.team.onSessionDeleted(key); } catch (e) { this.log.warn?.(`[lens] team delete: ${e.message}`); }
    }
    if (payload.reason === 'patch' && this.team?.onSessionPatched) {
      this.team.onSessionPatched(key).catch(e => this.log.warn?.(`[lens] team patch: ${e.message}`));
    }
    // Before the visibility check: a deleted session's bookmarks go even if the lens had it hidden.
    if (payload.reason === 'delete' && this.extras) this.extras.deleteThreadExtras?.(key);
    if (!this.observe(key, payload.session || payload)) return null;
    const out = trimEvent(payload);
    if (payload.reason !== 'delete') this._withParent(key, out.session || out);
    return { type: 'event', event: 'sessions.changed', payload: out };
  }

  /** `session.message` (live transcript entry). Forwarded only for watched visible chats. */
  sessionMessage(payload) {
    const key = payload?.sessionKey;
    if (!key || !this.isVisible(key) || ![...this.watching.values()].includes(key)) return null;
    const out = {};
    for (const k of Object.keys(payload)) if (k === 'message' || k === 'messageId' || k === 'messageSeq' || k === 'runId' || EVENT_ENVELOPE.has(k) || ROW_FIELDS.has(k)) out[k] = payload[k];
    return { type: 'event', event: 'session.message', payload: out };
  }

  // ── Browser → gateway ───────────────────────────────────────────────

  /**
   * Inspect a browser frame bound for the gateway. Returns the (possibly rewritten) frame
   * to send, or null when the lens answered it itself.
   */
  outbound(frame) {
    let msg;
    try { msg = JSON.parse(frame); } catch { return frame; }
    if (msg?.type !== 'req' || typeof msg.method !== 'string') return frame;
    const { id, method } = msg;
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    switch (method) {
      case 'sessions.unsubscribe':
        // The gateway subscription is per connection and the connector owns it.
        this.broadcast(JSON.stringify({ type: 'res', id, ok: true, payload: { subscribed: true } }));
        return null;
      case 'sessions.list':
      case 'sessions.subscribe': {
        this.pending.set(id, { method });
        // A bare subscribe only toggles the subscription; don't turn it into a list call.
        if (method === 'sessions.subscribe' && Object.keys(params).length === 0) return frame;
        return JSON.stringify({ ...msg, params: { ...LIST_DEFAULTS, ...params } });
      }
      case 'sessions.messages.subscribe':
        if (params.key) this.watching.set(params.subscriptionId || `key:${params.key}`, params.key);
        return frame;
      case 'sessions.messages.unsubscribe':
        if (params.subscriptionId) this.watching.delete(params.subscriptionId);
        else for (const [id, k] of this.watching) if (k === params.key) this.watching.delete(id);
        return frame;
      case 'sessions.search':
      case 'sessions.groups.rename':
      case 'sessions.groups.delete':
        this.pending.set(id, { method, params });
        return frame;
      default:
        return frame;
    }
  }

  ownsResponse(id) {
    return this.pending.has(id);
  }

  /** Response to a browser request the lens tracks. Returns the frame object to broadcast. */
  response(msg) {
    const req = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (!req || !msg.ok || !msg.payload) return msg;
    const p = msg.payload;
    switch (req.method) {
      case 'sessions.list':
        return { ...msg, payload: this._filterList(p) };
      case 'sessions.subscribe':
        return p.list ? { ...msg, payload: { ...p, list: this._filterList(p.list) } } : msg;
      case 'sessions.search': {
        const results = (p.results || []).filter(r => this.isVisible(r.sessionKey));
        const sessions = p.sessions ? this._visibleRows(p.sessions) : undefined;
        return { ...msg, payload: { ...p, results, ...(sessions ? { sessions } : {}) } };
      }
      case 'sessions.groups.rename':
        try { this.extras?.renameProjectStyle(req.params?.name, req.params?.to); }
        catch (e) { this.log.warn?.(`[lens] style rename: ${e.message}`); }
        return msg;
      case 'sessions.groups.delete':
        try { this.extras?.deleteProjectStyle(req.params?.name); }
        catch (e) { this.log.warn?.(`[lens] style delete: ${e.message}`); }
        return msg;
      default:
        return msg;
    }
  }

  _visibleRows(rows) {
    // Creation times of pre-gateway chats (their gateway row has no createdAt). Read per list so
    // `import-dates` applies without a restart; the browser store merges rows, so filling list
    // responses is enough.
    let legacy = null;
    try { legacy = this.extras?.getLegacyCreatedAt?.(); } catch (e) { this.log.warn?.(`[lens] legacy dates: ${e.message}`); }
    const out = [];
    // Learn the whole page first: a child may be listed before its parent.
    for (const row of rows || []) if (row) this.observe(row.key, row);
    for (const row of rows || []) {
      if (!row || !this.isVisible(row.key)) continue;
      const trimmed = this._withParent(row.key, trimRow(row));
      if (!trimmed.createdAt && legacy?.has(row.key)) trimmed.createdAt = legacy.get(row.key);
      out.push(trimmed);
    }
    return out;
  }

  _filterList(list) {
    if (!list || !Array.isArray(list.sessions)) return list;
    const sessions = this._visibleRows(list.sessions);
    // Keep paging (gateway offsets stay valid) and defaults; counts/facets described the
    // unfiltered roster, so `count` is recomputed and totals/owners are dropped.
    const out = { sessions, count: sessions.length };
    for (const k of ['ts', 'hasMore', 'nextOffset', 'limitApplied', 'defaults']) if (k in list) out[k] = list[k];
    return out;
  }

  /** Forget request ids that never got an answer (gateway disconnect). */
  reset() {
    this.pending.clear();
    this.watching.clear(); // gateway connection gone: browsers re-subscribe on reconnect
  }
}
