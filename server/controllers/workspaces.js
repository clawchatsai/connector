import fs from 'node:fs';
import path from 'node:path';
import { send, sendError, parseBody } from '../util/http.js';
import { validateAgent } from '../config.js';
import { isValidWorkspaceName } from '../util/workspace-name.js';
import { cleanGatewaySession, cleanGatewaySessionsByPrefix } from '../gateway-cleanup.js';

export class WorkspaceController {
  constructor({ getDb, closeDb, getWorkspaces, setWorkspaces, dataDir, broadcast }) {
    this.getDb = getDb;
    this.closeDb = closeDb;
    this.getWorkspaces = getWorkspaces;
    this.setWorkspaces = setWorkspaces;
    this.dataDir = dataDir;
    this.broadcast = broadcast;
  }

  getAll(req, res) {
    const ws = this.getWorkspaces();
    const sorted = Object.values(ws.workspaces).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    for (const workspace of sorted) {
      try {
        workspace.unread_count = this.getDb(workspace.name).prepare('SELECT COALESCE(SUM(unread_count), 0) as total FROM threads').get().total;
      } catch { workspace.unread_count = 0; }
    }
    send(res, 200, { active: ws.active, workspaces: sorted });
  }

  async create(req, res) {
    const body = await parseBody(req);
    const { name, label } = body;
    if (!isValidWorkspaceName(name)) return sendError(res, 400, 'Name must be [a-z0-9-], 1-32 chars');
    const ws = this.getWorkspaces();
    if (ws.workspaces[name]) return sendError(res, 409, 'Workspace already exists');
    let agent = 'main';
    try { agent = validateAgent(body.agent || 'main'); } catch { agent = 'main'; }
    ws.workspaces[name] = { name, label: label || name, color: body.color || null, icon: body.icon || null, agent, createdAt: Date.now() };
    this.setWorkspaces(ws);
    this.getDb(name);
    send(res, 201, { workspace: ws.workspaces[name] });
  }

  async update(req, res, params) {
    const body = await parseBody(req);
    const ws = this.getWorkspaces();
    if (!ws.workspaces[params.name]) return sendError(res, 404, 'Workspace not found');
    if (body.label !== undefined) ws.workspaces[params.name].label = body.label;
    if (body.color !== undefined) ws.workspaces[params.name].color = body.color;
    if (body.icon !== undefined) ws.workspaces[params.name].icon = body.icon;
    if (body.lastThread !== undefined) ws.workspaces[params.name].lastThread = body.lastThread;
    let migratedThreads = 0;
    if (body.agent !== undefined) {
      let newAgent;
      try { newAgent = validateAgent(body.agent); } catch (e) { return sendError(res, 400, e.message); }
      const oldAgent = ws.workspaces[params.name].agent || 'main';
      if (newAgent !== oldAgent) {
        const db = this.getDb(params.name);
        const threads = db.prepare(`SELECT id, session_key FROM threads WHERE session_key LIKE ?`).all(`agent:${oldAgent}:${params.name}:chat:%`);
        db.prepare(`UPDATE threads SET session_key = replace(session_key, 'agent:' || ? || ':' || ? || ':chat:', 'agent:' || ? || ':' || ? || ':chat:') WHERE session_key LIKE 'agent:' || ? || ':' || ? || ':chat:%'`).run(oldAgent, params.name, newAgent, params.name, oldAgent, params.name);
        for (const t of threads) cleanGatewaySession(t.session_key);
        ws.workspaces[params.name].agent = newAgent;
        migratedThreads = threads.length;
        this.broadcast(JSON.stringify({ type: 'clawchats', event: 'workspace-agent-changed', workspace: params.name, agent: newAgent }));
      }
    }
    this.setWorkspaces(ws);
    send(res, 200, { workspace: ws.workspaces[params.name], migratedThreads });
  }

  delete(req, res, params) {
    const ws = this.getWorkspaces();
    if (!ws.workspaces[params.name]) return sendError(res, 404, 'Workspace not found');
    if (Object.keys(ws.workspaces).length <= 1) return sendError(res, 400, 'Cannot delete the only workspace');
    this.closeDb(params.name);
    const dbPath = path.join(this.dataDir, `${params.name}.db`);
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch { /* ok */ } }
    const wsAgent = ws.workspaces[params.name]?.agent || 'main';
    const cleaned = cleanGatewaySessionsByPrefix(`agent:${wsAgent}:${params.name}:chat:`);
    if (cleaned > 0) console.log(`Cleaned ${cleaned} gateway sessions for workspace: ${params.name}`);
    delete ws.workspaces[params.name];
    if (ws.active === params.name) ws.active = Object.keys(ws.workspaces)[0] || null;
    this.setWorkspaces(ws);
    send(res, 200, { ok: true });
  }

  async reorder(req, res) {
    const body = await parseBody(req);
    if (!Array.isArray(body.order)) return sendError(res, 400, 'order must be an array of workspace names');
    const ws = this.getWorkspaces();
    body.order.forEach((name, i) => { if (ws.workspaces[name]) ws.workspaces[name].order = i; });
    this.setWorkspaces(ws);
    send(res, 200, { ok: true, workspaces: Object.values(ws.workspaces) });
  }

  activate(req, res, params) {
    const ws = this.getWorkspaces();
    if (!ws.workspaces[params.name]) return sendError(res, 404, 'Workspace not found');
    ws.active = params.name;
    this.setWorkspaces(ws);
    this.getDb(params.name);
    send(res, 200, { ok: true, workspace: ws.workspaces[params.name] });
  }
}
