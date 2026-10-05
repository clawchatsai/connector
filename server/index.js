import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Database } from './bootstrap/native.js';
import { GATEWAY_WS_URL, AUTH_TOKEN, discoverWorkspaceDir } from './config.js';
import { DebugLogger } from './debug.js';
import { GatewayClient } from './gateway.js';
import { handleServeFile, handleWorkspaceList, handleWorkspaceFileRead, handleWorkspaceFileWrite, handleWorkspaceFileDelete, handleWorkspaceUpload, handleWorkspaceCreate } from './controllers/filesystem.js';
import { handleTranscribe } from './controllers/transcribe.js';
import { createGatewayMediaHandler } from './controllers/gateway-media.js';
import { handleStatic } from './controllers/static.js';
import { handleAgents } from './controllers/agents.js';
import { createTitleHandler, createTitler } from './controllers/title.js';
import { createSettingsHandlers } from './controllers/settings.js';
import { createShareHandlers } from './controllers/shares.js';
import { createWorkspaceStore } from './store/workspace-store.js';
import { createExtrasStore } from './store/extras-store.js';
import { createTeamStore } from './store/team-store.js';
import { SessionLens } from './session-lens.js';
import { TeamCoordinator } from './team.js';
import { SharingManager } from './peer/sharing.js';
import { loadOrCreatePeerKey } from './peer/keys.js';
import { createGuestAgent } from './peer/guest-agent.js';
import { send, sendError, parseBody, uuid, matchRoute, setCors } from './util/http.js';

// PORT is passed via createApp(config.port); env var is read by plugin host (src/index.ts).
const DEFAULT_PORT = 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the plugin directory (parent of server/) for static file serving
const PLUGIN_DIR = path.resolve(__dirname, '..');

export function createApp(config = {}) {
  const PORT             = config.port           || DEFAULT_PORT;
  const DATA_DIR         = config.dataDir        || path.join(PLUGIN_DIR, 'data');
  const WORKSPACES_FILE  = path.join(DATA_DIR, 'workspaces.json');
  const SETTINGS_FILE    = path.join(DATA_DIR, 'settings.json');

  const authToken      = config.authToken    !== undefined ? config.authToken    : AUTH_TOKEN;
  const gatewayToken   = config.gatewayToken !== undefined ? config.gatewayToken : authToken;
  const gatewayUrl     = config.gatewayUrl   || GATEWAY_WS_URL;
  const openaiApiKey   = config.openaiApiKey || null;
  const handleTitle    = createTitleHandler(config.llm); // api.runtime.llm (plugin mode only)
  const shares         = createShareHandlers({ dataDir: DATA_DIR }); // share links → the user's own bucket

  fs.mkdirSync(DATA_DIR, { recursive: true });

  function closeAll() { sharing?.close(); gatewayClient?.close(); globalDbCache.close?.(); }

  // Global DB (custom emojis, cross-workspace data)
  let _globalDb = null;
  const globalDbCache = {
    get() {
      if (_globalDb) return _globalDb;
      _globalDb = new Database(path.join(DATA_DIR, 'global.db'));
      _globalDb.exec('PRAGMA journal_mode = WAL');
      _globalDb.exec(`CREATE TABLE IF NOT EXISTS custom_emojis (name TEXT NOT NULL, pack TEXT NOT NULL DEFAULT 'slackmojis', url TEXT NOT NULL, mime_type TEXT, created_at INTEGER DEFAULT (strftime('%s','now')), PRIMARY KEY (name, pack))`);
      return _globalDb;
    },
    close() { if (_globalDb) { _globalDb.close(); _globalDb = null; } }
  };

  // Workspace config (JSON sidecar) — file I/O lives in workspace-store.js
  const { getWorkspaces, setWorkspaces } = createWorkspaceStore(WORKSPACES_FILE);

  const debugLogger = new DebugLogger(DATA_DIR);

  const workspaceDir = discoverWorkspaceDir();

  // Instantiate the gateway client with all dependencies injected
  const gatewayClient = new GatewayClient({ dataDir: DATA_DIR, debugLogger, gatewayWsUrl: gatewayUrl, authToken: gatewayToken });
  const broadcast = msg => gatewayClient.broadcastToBrowsers(msg);
  // ClawChats-only data + the gateway↔browser session filter (gateway-native architecture).
  const extras = createExtrasStore(() => globalDbCache.get());
  try { const n = extras.seedFromWorkspaces(getWorkspaces()); if (n) console.log(`[extras] seeded ${n} project style(s) from workspaces.json`); }
  catch (e) { console.error('[extras] style seed failed:', e.message); }
  const gwRequest = (m, p, t) => gatewayClient.request(m, p, t);
  // Gateway sharing (server/peer/): other people's agents in team chats, and ours in theirs. The
  // plugin host (src/index.ts) supplies the signal server link and the peer transport (config.peer).
  const peerKey = loadOrCreatePeerKey(DATA_DIR);
  const sharing = config.peer ? new SharingManager({
    getDb: () => globalDbCache.get(), request: gwRequest, key: peerKey, broadcast,
    gatewayId: config.peer.gatewayId, signal: config.peer.signal, openPeer: config.peer.openPeer,
  }) : null;
  // Team chats: several agents in one thread (server/team.js).
  const team = new TeamCoordinator({ store: createTeamStore(() => globalDbCache.get()), request: gwRequest, broadcast, titler: createTitler(config.llm), remote: sharing });
  gatewayClient.onEvent = msg => { team.onGatewayEvent(msg); sharing?.onGatewayEvent(msg); };
  gatewayClient.lens = new SessionLens({ broadcast, request: gwRequest, extras, team });

  // A session's working root, for relative file links (gateway resolveSessionWorkspaceRoots:
  // spawnedCwd before sessionRoot). Cached briefly; null when the gateway can't say.
  const sessionRoots = new Map(); // key -> { root, at }
  async function sessionRoot(key) {
    const hit = sessionRoots.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.root;
    let root = null;
    try {
      const s = (await gatewayClient.request('sessions.describe', { key }, 5000))?.session;
      root = s?.spawnedCwd || s?.sessionRoot || null;
    } catch { /* fall back to the workspace */ }
    sessionRoots.set(key, { root, at: Date.now() });
    return root;
  }

  // Instantiate controllers
  const handleGatewayMedia = createGatewayMediaHandler({ gatewayWsUrl: gatewayUrl, gatewayToken });

  // Settings — file I/O lives in settings.js
  const { handleGetSettings, handleSaveSettings } = createSettingsHandlers(SETTINGS_FILE);

  // Auth middleware
  function checkAuth(req, res) {
    if (!authToken) return true;
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { sendError(res, 401, 'Missing or invalid Authorization header'); return false; }
    if (auth.slice(7) !== authToken) { sendError(res, 401, 'Invalid auth token'); return false; }
    return true;
  }

  // Request handler
  async function handleRequest(req, res) {
    return route(req, res);
  }

  async function route(req, res) {
    const [urlPath, queryString] = (req.url || '/').split('?');
    const query = {};
    if (queryString) for (const pair of queryString.split('&')) { const [k, v] = pair.split('='); if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || ''); }
    const method = req.method;
    let p;

    if (method === 'OPTIONS') { setCors(res); res.writeHead(204); return res.end(); }

    // Static file serving — file I/O lives in static.js
    if (method === 'GET' && !urlPath.startsWith('/api/')) {
      if (handleStatic(req, res, PLUGIN_DIR)) return;
    }

    // Unauthenticated routes

    if (method === 'GET' && urlPath === '/api/emoji') {
      try { const rows = globalDbCache.get().prepare('SELECT name, pack, url, mime_type FROM custom_emojis ORDER BY created_at DESC').all(); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }); return res.end(JSON.stringify(rows)); }
      catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    }

    if (method === 'GET' && urlPath === '/api/emoji/search') {
      const q = query.q || '';
      if (!q) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Missing ?q=' })); }
      try {
        const https = await import('https');
        const html = await new Promise((resolve, reject) => {
          https.default.get(`https://slackmojis.com/emojis/search?query=${encodeURIComponent(q)}`, resp => { let body = ''; resp.on('data', c => body += c); resp.on('end', () => resolve(body)); }).on('error', reject);
        });
        const results = [];
        const regex = /data-emoji-id-name="([^"]+)"[^>]*href="([^"]+)"[\s\S]*?<img[^>]*src="([^"]+)"/g;
        let match;
        while ((match = regex.exec(html)) !== null && results.length < 50) results.push({ name: match[1].replace(/^\d+-/, ''), image_url: match[3], download_url: `https://slackmojis.com${match[2]}` });
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(results));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    }

    if (!checkAuth(req, res)) return;

    try {
      // Emoji management
      if (method === 'POST' && urlPath === '/api/emoji/add') {
        const { url, name, pack } = await parseBody(req);
        if (!url || !name) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Missing url or name' })); }
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const targetPack = pack || 'slackmojis';
        const mimeType = url.toLowerCase().endsWith('.gif') ? 'image/gif' : url.toLowerCase().endsWith('.webp') ? 'image/webp' : url.toLowerCase().match(/\.jpe?g/) ? 'image/jpeg' : 'image/png';
        globalDbCache.get().prepare('INSERT OR REPLACE INTO custom_emojis (name, pack, url, mime_type) VALUES (?, ?, ?, ?)').run(safeName, targetPack, url, mimeType);
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ name: safeName, pack: targetPack, url, mime_type: mimeType }));
      }
      if (method === 'DELETE' && urlPath === '/api/emoji') {
        const { name, pack } = await parseBody(req);
        if (!name || !pack) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Missing name or pack' })); }
        globalDbCache.get().prepare('DELETE FROM custom_emojis WHERE name = ? AND pack = ?').run(name, pack);
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
      }

      // File serving & workspace browser
      if (method === 'GET' && urlPath === '/api/file') return handleServeFile(req, res, query, workspaceDir);
      if (method === 'GET' && urlPath === '/api/gw-media') return handleGatewayMedia(req, res, query);
      if (method === 'GET' && urlPath === '/api/workspace') return handleWorkspaceList(req, res, query);
      if (method === 'GET' && urlPath === '/api/workspace/file') return handleWorkspaceFileRead(req, res, query, workspaceDir, query.session ? await sessionRoot(query.session) : null);
      if (method === 'PUT' && urlPath === '/api/workspace/file') return await handleWorkspaceFileWrite(req, res, query);
      if (method === 'DELETE' && urlPath === '/api/workspace/file') return handleWorkspaceFileDelete(req, res, query);
      if (method === 'POST' && urlPath === '/api/workspace/upload') return await handleWorkspaceUpload(req, res, query);
      if (method === 'POST' && urlPath === '/api/workspace/create') return handleWorkspaceCreate(req, res, query);

      // Settings & misc
      if (method === 'GET' && urlPath === '/api/settings') return handleGetSettings(req, res);
      if (method === 'PUT' && urlPath === '/api/settings') return await handleSaveSettings(req, res, parseBody);
      if (method === 'POST' && urlPath === '/api/transcribe') return await handleTranscribe(req, res, { openaiApiKey });
      if (method === 'GET' && urlPath === '/api/health') return send(res, 200, { ok: true, workspace: getWorkspaces().active, uptime: process.uptime() });
      if (method === 'GET' && urlPath === '/api/agents') return handleAgents(req, res);
      if (method === 'POST' && urlPath === '/api/title') return await handleTitle(req, res);

      // ClawChats-only extras (see EXTRAS.md)
      if (method === 'GET' && urlPath === '/api/extras/project-styles') {
        extras.seedFromWorkspaces(getWorkspaces()); // legacy projects renamed by gateway sync keep their style
        return send(res, 200, { styles: extras.getProjectStyles() });
      }
      if ((p = matchRoute(method, urlPath, 'PUT /api/extras/project-styles/:name'))) {
        const body = await parseBody(req);
        extras.setProjectStyle(p.name, { color: body.color, icon: body.icon, preset: body.preset });
        broadcast(JSON.stringify({ type: 'clawchats', event: 'project-styles-changed' }));
        return send(res, 200, { styles: extras.getProjectStyles() });
      }
      if ((p = matchRoute(method, urlPath, 'DELETE /api/extras/project-styles/:name'))) {
        extras.deleteProjectStyle(p.name);
        broadcast(JSON.stringify({ type: 'clawchats', event: 'project-styles-changed' }));
        return send(res, 200, { ok: true });
      }
      // Share links: browser-encrypted envelopes uploaded to the user's own bucket (controllers/shares.js)
      if (method === 'GET' && urlPath === '/api/extras/shares') return await shares.handleList(req, res);
      if (method === 'POST' && urlPath === '/api/extras/shares/storage') return await shares.handleSetup(req, res);
      if (method === 'DELETE' && urlPath === '/api/extras/shares/storage') return shares.handleForgetStorage(req, res);
      if (method === 'POST' && urlPath === '/api/extras/shares') return await shares.handleCreate(req, res);
      if ((p = matchRoute(method, urlPath, 'DELETE /api/extras/shares/:id'))) return await shares.handleRevoke(req, res, p.id);
      if (method === 'GET' && urlPath === '/api/extras/bookmarks') return send(res, 200, { bookmarks: extras.listBookmarks() });
      if (method === 'POST' && urlPath === '/api/extras/bookmarks') {
        const bookmark = extras.addBookmark(uuid(), await parseBody(req));
        if (!bookmark) return sendError(res, 400, 'sessionKey and messageId are required');
        broadcast(JSON.stringify({ type: 'clawchats', event: 'bookmarks-changed' }));
        return send(res, 200, { bookmark });
      }
      if ((p = matchRoute(method, urlPath, 'PATCH /api/extras/bookmarks/:id'))) {
        const bookmark = extras.renameBookmark(p.id, (await parseBody(req)).label);
        if (!bookmark) return sendError(res, 404, 'Bookmark not found, or empty label');
        broadcast(JSON.stringify({ type: 'clawchats', event: 'bookmarks-changed' }));
        return send(res, 200, { bookmark });
      }
      if ((p = matchRoute(method, urlPath, 'DELETE /api/extras/bookmarks/:id'))) {
        if (extras.deleteBookmark(p.id)) broadcast(JSON.stringify({ type: 'clawchats', event: 'bookmarks-changed' }));
        return send(res, 200, { ok: true });
      }

      // Gateway sharing (server/peer/sharing.js). Approve/revoke happen here, behind this gateway's TOTP.
      if (method === 'GET' && urlPath === '/api/sharing') {
        if (!sharing) return send(res, 200, { enabled: false, shares: [], remoteAgents: [] });
        return send(res, 200, { enabled: true, fingerprint: peerKey.fingerprint, shares: sharing.list(), remoteAgents: sharing.remoteAgents() });
      }
      if ((p = matchRoute(method, urlPath, 'POST /api/sharing/:id/approve'))) {
        if (!sharing) return sendError(res, 404, 'Sharing is not available');
        try { return send(res, 200, { grant: sharing.approve(p.id, await parseBody(req)) }); }
        catch (e) { return sendError(res, 400, e.message); }
      }
      if (method === 'POST' && urlPath === '/api/sharing/guest-agent') {
        // Owner asks for a guest version of one of its agents (peer/guest-agent.js); changes this gateway's config.
        const { agentId } = await parseBody(req);
        if (typeof agentId !== 'string' || !agentId) return sendError(res, 400, 'agentId is required');
        try { return send(res, 200, await createGuestAgent(gwRequest, agentId)); }
        catch (e) { return sendError(res, 400, e.message); }
      }
      if ((p = matchRoute(method, urlPath, 'POST /api/sharing/:id/revoke'))) {
        if (!sharing) return sendError(res, 404, 'Sharing is not available');
        sharing.revoke(p.id);
        return send(res, 200, { ok: true });
      }

      // Team chats (server/team.js; EXTRAS.md). Room keys contain ':' and are URL-encoded.
      if (method === 'GET' && urlPath === '/api/team') return send(res, 200, { rooms: team.rooms() });
      if (method === 'POST' && urlPath === '/api/team') {
        const body = await parseBody(req);
        try { return send(res, 200, { room: await team.createRoom(body) }); }
        catch (e) { return sendError(res, 400, e.message); }
      }
      if ((p = matchRoute(method, urlPath, 'GET /api/team/:room'))) {
        const room = team.room(p.room);
        return room ? send(res, 200, { room }) : sendError(res, 404, 'Not a team chat');
      }
      if ((p = matchRoute(method, urlPath, 'PATCH /api/team/:room'))) {
        const room = team.setDiscuss(p.room, (await parseBody(req)).discuss);
        return room ? send(res, 200, { room }) : sendError(res, 404, 'Not a team chat');
      }
      if ((p = matchRoute(method, urlPath, 'POST /api/team/:room/agents'))) {
        const { agentId } = await parseBody(req);
        if (typeof agentId !== 'string' || !agentId) return sendError(res, 400, 'agentId is required');
        try {
          const room = await team.addAgent(p.room, agentId);
          return room ? send(res, 200, { room }) : sendError(res, 404, 'Not a team chat');
        } catch (e) { return sendError(res, 400, e.message); }
      }
      if ((p = matchRoute(method, urlPath, 'DELETE /api/team/:room/agents/:agentId'))) {
        try {
          const room = team.removeAgent(p.room, p.agentId);
          return room ? send(res, 200, { room }) : sendError(res, 404, 'Not a team chat');
        } catch (e) { return sendError(res, 400, e.message); }
      }
      if ((p = matchRoute(method, urlPath, 'POST /api/team/:room/send'))) {
        try { return send(res, 200, await team.send(p.room, await parseBody(req))); }
        catch (e) { return sendError(res, 400, e.message); }
      }
      if ((p = matchRoute(method, urlPath, 'POST /api/team/:room/unconvert'))) {
        try {
          const sourceKey = await team.unconvert(p.room);
          return sourceKey ? send(res, 200, { sourceKey }) : sendError(res, 404, 'Not a team chat');
        } catch (e) { return sendError(res, 400, e.message); }
      }
      if ((p = matchRoute(method, urlPath, 'POST /api/team/:room/stop'))) {
        await team.stop(p.room);
        return send(res, 200, { ok: true });
      }


      sendError(res, 404, `Not found: ${method} ${urlPath}`);
    } catch (err) {
      console.error(`Error handling ${method} ${urlPath}:`, err);
      if (err.gatewayError) sendError(res, 502, `Gateway: ${err.message}`);
      else if (err.message?.includes('UNIQUE constraint')) sendError(res, 409, 'Conflict: ' + err.message);
      else sendError(res, 500, err.message || 'Internal server error');
    }
  }

  // Browser WebSocket setup (shared by standalone and plugin modes)
  function setupBrowserWs(wss) {
    wss.on('connection', ws => {
      console.log('Browser client connected');
      gatewayClient.addBrowserClient(ws);
      ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: uuid(), ts: Date.now() } }));

      ws.on('message', async data => {
        const msgStr = data.toString();
        debugLogger.logFrame('BR→SRV', msgStr);
        try {
          const msg = JSON.parse(msgStr);
          if (msg.type === 'req' && msg.method === 'connect') {
            const token = msg.params?.auth?.token;
            if (token === authToken || !authToken) {
              ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: { type: 'hello-ok', protocol: 3, server: { version: '0.1.0', host: 'clawchats-backend' } } }));
            } else {
              ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: false, error: { code: 'AUTH_FAILED', message: 'Invalid auth token' } }));
              ws.close();
            }
            return;
          }
          if (msg.type === 'clawchats' || msg.type === 'shellchat') {
            if (msg.action === 'active-thread') return; // sent by pre-gateway-native frontends; nothing to track now
            if (msg.action === 'debug-start') { const r = debugLogger.start(msg.ts, ws); ws.send(JSON.stringify(r.error === 'already-active' ? { type: 'clawchats', event: 'debug-error', error: 'Recording already active in another tab', sessionId: r.sessionId } : { type: 'clawchats', event: 'debug-started', sessionId: r.sessionId })); return; }
            if (msg.action === 'debug-dump') { const r = debugLogger.saveDump(msg); ws.send(JSON.stringify({ type: 'clawchats', event: 'debug-saved', sessionId: r.sessionId, files: r.files })); return; }
          }
        } catch { /* not JSON or not a ClawChats message, forward as-is */ }
        gatewayClient.forwardFromBrowser(msgStr);
      });

      ws.on('close', () => { console.log('Browser client disconnected'); debugLogger.handleClientDisconnect(ws); gatewayClient.removeBrowserClient(ws); });
      ws.on('error', err => console.error('Browser WebSocket error:', err.message));
    });
  }

  return {
    handleRequest,
    getWorkspaces,
    setWorkspaces,
    shutdown: closeAll,
    gatewayClient,
    extras,
    team,
    sharing,
    peerKey,
    setupBrowserWs,
    debugLogger,
    dataDir: DATA_DIR,
  };
}

// Standalone mode (node server/index.js or via isDirectRun check in bundle)
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const app = createApp();

  const server = http.createServer(app.handleRequest);
  const wss = new WebSocketServer({ noServer: true });
  app.setupBrowserWs(wss);
  server.on('upgrade', (req, socket, head) => { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); });
  server.listen(PORT, () => {
    console.log(`ClawChats backend listening on port ${PORT}`);
    console.log(`Active workspace: ${app.getWorkspaces().active}`);
    console.log(`Data dir: ${app.dataDir}`);
    app.gatewayClient.connect();
  });

  const shutdown = () => { console.log('Shutting down...'); app.shutdown(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
