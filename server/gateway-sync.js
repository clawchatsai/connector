// Keeps ClawChats projects/threads and the gateway's session organization in step.
//
//   ClawChats project  <->  gateway session group (catalog entry + each session's `category`)
//   ClawChats title    <->  session `label` (custom name, unique per agent store)
//   ClawChats pinned   <->  session `pinned`
//   ClawChats delete   <->  `sessions.delete`
//
// The gateway owns organization. ClawChats actions are written to the gateway first
// (controllers call the push methods and fail if the gateway rejects); gateway-side
// changes arrive as `sessions.changed` events (plus a full reconcile on connect, on
// unkeyed/group events and every few minutes, since slow clients can miss events).
// Every write compares first, so the connector's own changes echo back as no-ops.
//
// A thread is only pulled from the gateway (moved, renamed, deleted) once the connector
// has seen its session at least once (`threads.gateway_seen_at`). Until then the
// connector pushes ClawChats' state to the gateway instead. That makes the first run
// after upgrade/import a seed, and keeps never-imported threads safe.

import fs from 'node:fs';
import path from 'node:path';
import { parseSessionKey } from './util/helpers.js';
import { moveThread as moveThreadRows } from './thread-move.js';

export const DEFAULT_PROJECT_LABEL = 'Default';
const PLACEHOLDER_TITLES = new Set(['New chat', '']);
const LABEL_MAX = 512;
const MAX_SUFFIX = 1000;
const PERIODIC_RECONCILE_MS = 5 * 60 * 1000;
const RECONCILE_DEBOUNCE_MS = 400;
// Refuse to mirror mass deletions found during a reconcile (missed events are normal;
// dozens of sessions vanishing at once is far more likely a gateway-side problem).
const MAX_RECONCILE_DELETES = 5;

export function withSuffix(base, n) {
  return n <= 1 ? base : `${base} (${n})`;
}

export function isPushableTitle(title) {
  return typeof title === 'string' && !PLACEHOLDER_TITLES.has(title.trim());
}

function isNotFound(err) {
  return /not found|no session|unknown session/i.test(err?.message || '');
}

function isLabelTaken(err) {
  return /label already in use/i.test(err?.message || '');
}

function slugify(label, taken) {
  const base = (label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project').slice(0, 28);
  let name = base, n = 2;
  while (taken.has(name)) name = `${base}-${n++}`;
  return name;
}

export class GatewaySync {
  constructor({ gateway, getDb, closeDb, getWorkspaces, setWorkspaces, dataDir, uploadsDir, broadcast, logger = console }) {
    this.gateway = gateway;
    this.getDb = getDb;
    this.closeDb = closeDb;
    this.getWorkspaces = getWorkspaces;
    this.setWorkspaces = setWorkspaces;
    this.dataDir = dataDir;
    this.uploadsDir = uploadsDir;
    this._changed = { projects: false, threads: new Set() };
    this.broadcast = broadcast;
    this.log = logger;
    this.statePath = path.join(dataDir, 'gateway-sync.json');
    this.state = this._loadState();
    this.locations = new Map(); // threadId -> project name, for threads that moved away from their key's project
    this.labels = new Map(); // label -> session key, from the last full list (pre-check only; gateway is authoritative)
    this._queue = Promise.resolve();
    // key -> newest gateway `updatedAt` applied or written. Event rows are captured
    // snapshots that can arrive after a newer write; anything older is ignored
    // (same nondecreasing-recency rule the gateway's Control UI uses).
    this.recency = new Map();
    this._reconcileQueued = false;
    this._reconcileTimer = null;
    this._periodic = null;
    this._indexLocations();
  }

  // ── State ────────────────────────────────────────────────────────────

  _loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (s && s.version === 1) return s;
    } catch { /* first run */ }
    return { version: 1, catalog: null };
  }

  _saveState() {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  /**
   * Gateway-first write for a ClawChats action: runs in the sync queue and tags failures
   * so the HTTP layer answers 502 and the caller skips its local change.
   */
  async push(fn) {
    try { return await this.run(fn); }
    catch (e) { e.gatewayError = true; throw e; }
  }

  /** sessions.patch that records the resulting `updatedAt`, so older event snapshots are ignored. */
  async _patch(params) {
    const res = await this.gateway.request('sessions.patch', params);
    this._seen(params.key, res?.entry?.updatedAt);
    return res;
  }

  /** Record a gateway `updatedAt`; returns false if it is older than one already seen. */
  _seen(key, updatedAt) {
    if (typeof updatedAt !== 'number') return true;
    const prev = this.recency.get(key);
    if (prev !== undefined && updatedAt < prev) return false;
    this.recency.set(key, updatedAt);
    return true;
  }

  /** Serialize all sync work (pushes, event handling, reconciles). */
  run(fn) {
    const next = this._queue.then(fn);
    this._queue = next.catch(() => {});
    return next;
  }

  // ── Thread location (key → project) ─────────────────────────────────

  _projects() {
    return Object.values(this.getWorkspaces().workspaces).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  }

  _indexLocations() {
    this.locations.clear();
    for (const p of this._projects()) {
      let rows = [];
      try { rows = this.getDb(p.name).prepare('SELECT id, session_key FROM threads').all(); } catch { continue; }
      for (const r of rows) {
        const parsed = parseSessionKey(r.session_key);
        if (parsed && parsed.workspace !== p.name) this.locations.set(r.id, p.name);
      }
    }
  }

  /** parseSessionKey + current project of threads that moved. Same shape as parseSessionKey. */
  locate(sessionKey) {
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) return null;
    const moved = this.locations.get(parsed.threadId);
    return moved ? { ...parsed, workspace: moved } : parsed;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async onConnected() {
    try {
      await this.gateway.request('sessions.subscribe', {});
    } catch (e) {
      this.log.warn?.(`[sync] sessions.subscribe failed: ${e.message}`);
    }
    this.scheduleReconcile(0);
    if (!this._periodic) {
      this._periodic = setInterval(() => this.scheduleReconcile(0), PERIODIC_RECONCILE_MS);
      this._periodic.unref?.();
    }
  }

  stop() {
    if (this._periodic) clearInterval(this._periodic);
    if (this._reconcileTimer) clearTimeout(this._reconcileTimer);
    this._periodic = this._reconcileTimer = null;
  }

  scheduleReconcile(delay = RECONCILE_DEBOUNCE_MS) {
    if (this._reconcileTimer) clearTimeout(this._reconcileTimer);
    this._reconcileTimer = setTimeout(() => {
      this._reconcileTimer = null;
      if (this._reconcileQueued) return; // one waiting pass covers everything that happened before it starts
      this._reconcileQueued = true;
      this.run(() => { this._reconcileQueued = false; return this.reconcile(); })
        .catch(e => this.log.error?.(`[sync] reconcile failed: ${e.message}`));
    }, delay);
    this._reconcileTimer.unref?.();
  }

  /** `sessions.changed` event from the gateway. */
  onSessionsChanged(payload) {
    if (!payload) return;
    const key = payload.sessionKey;
    if (!key || payload.reason === 'groups') { this.scheduleReconcile(); return; }
    if (key.includes('__clawchats_title_')) return;
    if (!parseSessionKey(key)) return; // not a ClawChats thread
    this.run(async () => {
      if (payload.reason === 'delete') return this._onSessionDeleted(key);
      if (payload.session) return this._applyEventRow(payload.session, payload.reason);
    }).catch(e => this.log.error?.(`[sync] ${payload.reason} ${key}: ${e.message}`));
  }

  // ── Push: ClawChats → gateway (called by controllers inside run()) ───

  async _catalogNames() {
    const res = await this.gateway.request('sessions.groups.list', {});
    return (res?.groups || []).slice().sort((a, b) => a.position - b.position).map(g => g.name);
  }

  _uniqueProjectLabel(label, exceptName = null) {
    const used = new Set(this._projects().filter(p => p.name !== exceptName).map(p => p.label));
    let n = 1;
    while (used.has(withSuffix(label, n))) n++;
    return withSuffix(label, n);
  }

  /** New project. Returns the (possibly suffixed) label to store. */
  async projectCreated(label) {
    const unique = this._uniqueProjectLabel(label);
    const names = await this._catalogNames();
    if (!names.includes(unique)) await this.gateway.request('sessions.groups.put', { names: [...names, unique] });
    this.state.catalog = [...new Set([...names, unique])];
    this._saveState();
    return unique;
  }

  /** Project renamed. Returns the (possibly suffixed) label to store. */
  async projectRenamed(name, fromLabel, toLabel) {
    const unique = this._uniqueProjectLabel(toLabel, name);
    if (unique === fromLabel) return unique;
    const names = await this._catalogNames();
    if (names.includes(fromLabel)) {
      await this.gateway.request('sessions.groups.rename', { name: fromLabel, to: unique });
    } else if (!names.includes(unique)) {
      await this.gateway.request('sessions.groups.put', { names: [...names, unique] });
    }
    this.state.catalog = await this._catalogNames();
    this._saveState();
    return unique;
  }

  /** Project deleted (its sessions were already deleted). */
  async projectDeleted(label) {
    const names = await this._catalogNames();
    if (names.includes(label)) {
      try { await this.gateway.request('sessions.groups.delete', { name: label }); }
      catch (e) { if (!/unknown session group/i.test(e.message)) throw e; }
    }
    this.state.catalog = (this.state.catalog || names).filter(n => n !== label);
    this._saveState();
  }

  /** Projects reordered; `labels` in the new order. */
  async projectsReordered(labels) {
    const names = await this._catalogNames();
    const ordered = [...labels.filter(l => names.includes(l)), ...names.filter(n => !labels.includes(n))];
    if (ordered.join('\u0000') !== names.join('\u0000')) await this.gateway.request('sessions.groups.put', { names: ordered });
    this.state.catalog = ordered;
    this._saveState();
  }

  /**
   * Set a thread's title as the session's custom name, adding " (n)" until the gateway
   * accepts it. Returns the accepted title, or the input unchanged when the session
   * doesn't exist yet (it gets pushed when first seen) or the title is a placeholder.
   */
  async pushTitle(sessionKey, title) {
    if (!isPushableTitle(title)) return title;
    const base = title.trim().slice(0, LABEL_MAX - 8);
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const candidate = withSuffix(base, n);
      const owner = this.labels.get(candidate);
      if (owner && owner !== sessionKey) continue;
      try {
        await this._patch({ key: sessionKey, label: candidate });
        this._rememberLabel(sessionKey, candidate);
        return candidate;
      } catch (e) {
        if (isNotFound(e)) return title;
        if (isLabelTaken(e)) { this.labels.set(candidate, '?'); continue; }
        throw e;
      }
    }
    throw new Error(`no free title for "${base}"`);
  }

  _rememberLabel(sessionKey, label) {
    for (const [l, k] of this.labels) if (k === sessionKey) this.labels.delete(l);
    this.labels.set(label, sessionKey);
  }

  async pushPinned(sessionKey, pinned) {
    try { await this._patch({ key: sessionKey, pinned: !!pinned }); }
    catch (e) { if (!isNotFound(e)) throw e; }
  }

  /** Gateway-first thread delete. Throws if the gateway refuses (not-found is fine). */
  async deleteSession(sessionKey) {
    try { await this.gateway.request('sessions.delete', { key: sessionKey, deleteTranscript: true }); }
    catch (e) { if (!isNotFound(e)) throw e; }
  }

  /** Title generated server-side (not user-initiated): push, adopt a suffix if one was needed. */
  titleGenerated(projectName, threadId, sessionKey, title) {
    this.run(async () => {
      const accepted = await this.pushTitle(sessionKey, title);
      if (accepted !== title) this._setLocalTitle(projectName, threadId, accepted);
    }).catch(e => this.log.warn?.(`[sync] title push failed for ${threadId}: ${e.message}`));
  }

  // ── Pull: gateway → ClawChats ────────────────────────────────────────

  _projectByLabel(label) {
    return this._projects().find(p => p.label === label) || null;
  }

  _ensureProject(label) {
    const existing = this._projectByLabel(label);
    if (existing) return existing;
    const ws = this.getWorkspaces();
    const name = slugify(label, new Set(Object.keys(ws.workspaces)));
    const maxOrder = Math.max(-1, ...Object.values(ws.workspaces).map(p => p.order ?? -1));
    ws.workspaces[name] = { name, label, color: null, icon: null, agent: 'main', createdAt: Date.now(), order: maxOrder + 1 };
    this.setWorkspaces(ws);
    this.getDb(name);
    this.log.info?.(`[sync] created project "${label}" (${name}) from gateway group`);
    this._changed.projects = true;
    return ws.workspaces[name];
  }

  _findThread(sessionKey) {
    const loc = this.locate(sessionKey);
    if (!loc || !this.getWorkspaces().workspaces[loc.workspace]) return null;
    const row = this.getDb(loc.workspace).prepare('SELECT id, session_key, title, pinned, gateway_seen_at FROM threads WHERE id = ?').get(loc.threadId);
    return row && row.session_key === sessionKey ? { ...row, project: loc.workspace } : null;
  }

  _setLocalTitle(project, threadId, title) {
    this.getDb(project).prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, threadId);
    this.broadcast(JSON.stringify({ type: 'clawchats', event: 'thread-title-updated', threadId, workspace: project, title }));
  }

  _moveThread(threadId, from, to) {
    if (!moveThreadRows(this.getDb, threadId, from, to)) return;
    this.locations.set(threadId, to);
    this.log.info?.(`[sync] moved thread ${threadId} ${from} → ${to}`);
    this._changed.threads.add(from).add(to);
  }

  /** First sight of a session for a ClawChats thread: push ClawChats' state, mark seen. */
  async _seed(t, row) {
    const project = this.getWorkspaces().workspaces[t.project];
    const patch = {};
    if (row.category !== project.label) patch.category = project.label;
    if (!!row.pinned !== !!t.pinned) patch.pinned = !!t.pinned;
    if (Object.keys(patch).length) await this._patch({ key: row.key, ...patch });
    if (isPushableTitle(t.title) && row.label !== t.title) {
      const accepted = await this.pushTitle(row.key, t.title);
      if (accepted !== t.title) this._setLocalTitle(t.project, t.id, accepted);
    }
    this.getDb(t.project).prepare('UPDATE threads SET gateway_seen_at = ? WHERE id = ?').run(Date.now(), t.id);
  }

  /** Gateway → ClawChats for one field set. `row` may be partial: absent fields mean "unchanged". */
  _pullFields(t, row, source) {
    if (typeof row.category === 'string' && row.category) {
      const target = this._projectByLabel(row.category);
      if (!target) return 'unknown-group';
      if (target.name !== t.project) {
        this.log.info?.(`[sync] ${source}: "${row.category}" for ${t.id} (updatedAt ${row.updatedAt})`);
        this._moveThread(t.id, t.project, target.name);
        t.project = target.name;
      }
    }
    if (typeof row.label === 'string' && row.label && row.label !== t.title) this._setLocalTitle(t.project, t.id, row.label);
    if (typeof row.pinned === 'boolean' && row.pinned !== !!t.pinned) {
      this.getDb(t.project).prepare('UPDATE threads SET pinned = ? WHERE id = ?').run(row.pinned ? 1 : 0, t.id);
      this._changed.threads.add(t.project);
    }
    return 'ok';
  }

  /**
   * `sessions.changed` row. Never writes to the gateway (event rows are partial captured
   * snapshots); anything needing a write or a complete row is left to a full reconcile.
   */
  async _applyEventRow(row, reason) {
    const t = this._findThread(row.key);
    if (!t) return;
    if (!t.gateway_seen_at) { this.scheduleReconcile(); return; } // seeding happens in a full pass
    if (!this._seen(row.key, row.updatedAt)) return; // older than what we already applied/wrote
    if (this._pullFields(t, row, `event ${reason}`) === 'unknown-group') { this.scheduleReconcile(); return; }
    if ('category' in row && !row.category) this.scheduleReconcile(); // explicit ungroup: reconcile decides
    this._flushChanged();
  }

  /** Full `sessions.list` row during reconcile: complete, so absence means unset. */
  async _applyListRow(row) {
    const t = this._findThread(row.key);
    if (!t) return;
    if (!this._seen(row.key, row.updatedAt)) return;
    if (!t.gateway_seen_at) return this._seed(t, row);
    if (!row.category) {
      // Ungrouped in the gateway → Default (both sides).
      await this._patch({ key: row.key, category: DEFAULT_PROJECT_LABEL });
      row = { ...row, category: DEFAULT_PROJECT_LABEL };
    }
    this._ensureProject(row.category);
    this._pullFields(t, row, 'reconcile');
    if (!row.label && isPushableTitle(t.title)) {
      const accepted = await this.pushTitle(row.key, t.title);
      if (accepted !== t.title) this._setLocalTitle(t.project, t.id, accepted);
    }
  }

  _onSessionDeleted(sessionKey) {
    const t = this._findThread(sessionKey);
    if (!t || !t.gateway_seen_at) return;
    this._deleteLocalThread(t);
    this._flushChanged();
  }

  _deleteLocalThread(t) {
    this.getDb(t.project).prepare('DELETE FROM threads WHERE id = ?').run(t.id);
    this.locations.delete(t.id);
    try { fs.rmSync(path.join(this.uploadsDir, t.id), { recursive: true }); } catch { /* none */ }
    this.log.info?.(`[sync] deleted thread ${t.id} (session deleted in gateway)`);
    this._changed.threads.add(t.project);
  }

  _flushChanged() {
    const c = this._changed;
    this._changed = { projects: false, threads: new Set() };
    if (c.projects) this.broadcast(JSON.stringify({ type: 'clawchats', event: 'workspaces-changed' }));
    if (c.threads.size) this.broadcast(JSON.stringify({ type: 'clawchats', event: 'threads-changed', workspaces: [...c.threads] }));
  }

  async _listAllSessions() {
    const out = [];
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const res = await this.gateway.request('sessions.list', { archived: 'all', limit: 1000, offset }, 60000);
      out.push(...(res?.sessions || []));
      if (!res?.hasMore || res.nextOffset == null) break;
      offset = res.nextOffset;
    }
    return out;
  }

  /** Full two-way pass. Must run inside run(). */
  async reconcile() {
    if (!this.gateway.connected) return;
    const [names, sessions] = await Promise.all([this._catalogNames(), this._listAllSessions()]);
    this.labels = new Map(sessions.filter(s => s.label).map(s => [s.label, s.key]));
    const firstRun = !Array.isArray(this.state.catalog);
    const last = this.state.catalog || [];

    // 1. Duplicate project labels (exact, like the gateway) → suffix in ClawChats.
    const seen = new Set();
    const ws = this.getWorkspaces();
    for (const p of this._projects()) {
      if (seen.has(p.label)) { p.label = this._uniqueProjectLabel(p.label, p.name); this._changed.projects = true; }
      seen.add(p.label);
    }
    if (this._changed.projects) this.setWorkspaces(ws);

    // 2. Group-level changes made in the gateway since the last pass.
    const projectsToDelete = new Set();
    if (!firstRun) {
      const labels = new Set(this._projects().map(p => p.label));
      const vanished = last.filter(n => !names.includes(n) && labels.has(n));
      const appeared = names.filter(n => !last.includes(n) && !labels.has(n));
      if (vanished.length === 1 && appeared.length === 1) {
        const p = this._projectByLabel(vanished[0]);
        p.label = appeared[0];
        this.setWorkspaces(this.getWorkspaces());
        this.log.info?.(`[sync] project "${vanished[0]}" renamed to "${appeared[0]}" in gateway`);
        this._changed.projects = true;
      } else {
        for (const n of appeared) this._ensureProject(n);
        for (const n of vanished) projectsToDelete.add(this._projectByLabel(n).name);
      }
    }
    this._ensureProject(DEFAULT_PROJECT_LABEL);

    // 3. Sessions ↔ threads.
    const present = new Set();
    for (const row of sessions) {
      present.add(row.key);
      if (!parseSessionKey(row.key)) continue;
      try { await this._applyListRow(row); }
      catch (e) { this.log.warn?.(`[sync] ${row.key}: ${e.message}`); }
    }

    // 4. Seen threads whose session is gone were deleted in the gateway.
    const gone = [];
    for (const p of this._projects()) {
      for (const t of this.getDb(p.name).prepare('SELECT id, session_key, gateway_seen_at FROM threads WHERE gateway_seen_at IS NOT NULL').all()) {
        if (!present.has(t.session_key)) gone.push({ ...t, project: p.name });
      }
    }
    if (gone.length > MAX_RECONCILE_DELETES) {
      this.log.warn?.(`[sync] ${gone.length} synced threads have no gateway session — NOT deleting (limit ${MAX_RECONCILE_DELETES}). Check the gateway.`);
    } else {
      for (const t of gone) this._deleteLocalThread(t);
    }

    // 5. Projects whose group was deleted in the gateway: chats moved to Default above.
    const def = this._projectByLabel(DEFAULT_PROJECT_LABEL);
    for (const name of projectsToDelete) {
      if (name === def.name) continue;
      const db = this.getDb(name);
      for (const t of db.prepare('SELECT id FROM threads').all()) this._moveThread(t.id, name, def.name);
      this._deleteLocalProject(name);
    }

    // 6. Catalog ⇄ projects.
    const projects = this._projects();
    let finalNames;
    if (firstRun) {
      // Seed: ClawChats order; keep non-ClawChats groups that still have members.
      const members = new Map();
      for (const s of sessions) if (s.category) members.set(s.category, (members.get(s.category) || 0) + 1);
      const claw = new Set();
      for (const s of sessions) if (parseSessionKey(s.key) && this._findThread(s.key)) claw.add(s.key);
      const foreignMembers = new Map();
      for (const s of sessions) if (s.category && !claw.has(s.key)) foreignMembers.set(s.category, (foreignMembers.get(s.category) || 0) + 1);
      for (const n of names) if (!this._projectByLabel(n) && foreignMembers.get(n)) this._ensureProject(n);
      finalNames = this._projects().map(p => p.label);
    } else {
      // Gateway order wins; projects missing from the catalog are appended.
      finalNames = [...names.filter(n => this._projectByLabel(n)), ...projects.map(p => p.label).filter(l => !names.includes(l))];
      const wsNow = this.getWorkspaces();
      finalNames.forEach((label, i) => {
        const p = this._projectByLabel(label);
        if (p && p.order !== i) { wsNow.workspaces[p.name].order = i; this._changed.projects = true; }
      });
      if (this._changed.projects) this.setWorkspaces(wsNow);
    }
    const current = await this._catalogNames();
    if (finalNames.join('\u0000') !== current.join('\u0000')) {
      // Groups not in finalNames must be empty by now; put rejects dropping non-empty ones.
      await this.gateway.request('sessions.groups.put', { names: finalNames });
    }
    this.state.catalog = finalNames;
    this._saveState();

    // 7. Leftover title-generation sessions.
    for (const s of sessions) {
      if (s.key.includes('__clawchats_title_')) {
        try { await this.deleteSession(s.key); } catch (e) { this.log.warn?.(`[sync] title session cleanup: ${e.message}`); }
      }
    }

    const unseen = this._projects().reduce((n, p) => n + this.getDb(p.name).prepare('SELECT COUNT(*) c FROM threads WHERE gateway_seen_at IS NULL').get().c, 0);
    this.log.info?.(`[sync] reconcile done: ${sessions.length} sessions, ${finalNames.length} groups, ${unseen} ClawChats threads not in the gateway`);
    this._flushChanged();
  }

  _deleteLocalProject(name) {
    const ws = this.getWorkspaces();
    if (!ws.workspaces[name] || Object.keys(ws.workspaces).length <= 1) return;
    this.closeDb(name);
    const dbPath = path.join(this.dataDir, `${name}.db`);
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch { /* ok */ } }
    delete ws.workspaces[name];
    if (ws.active === name) ws.active = this._projectByLabel(DEFAULT_PROJECT_LABEL)?.name || Object.keys(ws.workspaces)[0];
    this.setWorkspaces(ws);
    this.log.info?.(`[sync] deleted project ${name} (group deleted in gateway)`);
    this._changed.projects = true;
  }
}
