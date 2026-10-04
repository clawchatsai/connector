import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Database } from './bootstrap/native.js';
import { GATEWAY_WS_URL, AUTH_TOKEN, discoverWorkspaceDir } from './config.js';
import { DebugLogger } from './debug.js';
import { GatewayClient } from './gateway.js';
import { handleServeFile, handleWorkspaceList, handleWorkspaceFileRead, handleWorkspaceFileWrite, handleWorkspaceFileDelete, handleWorkspaceUpload } from './controllers/filesystem.js';
import { handleTranscribe } from './controllers/transcribe.js';
import { createGatewayMediaHandler } from './controllers/gateway-media.js';
import { handleStatic } from './controllers/static.js';
import { handleAgents } from './controllers/agents.js';
import { createTitleHandler } from './controllers/title.js';
import { createSettingsHandlers } from './controllers/settings.js';
import { createWorkspaceStore } from './store/workspace-store.js';
import { createExtrasStore } from './store/extras-store.js';
import { SessionLens } from './session-lens.js';
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

  fs.mkdirSync(DATA_DIR, { recursive: true });

  function closeAll() { gatewayClient?.close(); globalDbCache.close?.(); }

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
  gatewayClient.lens = new SessionLens({ broadcast, request: (m, p, t) => gatewayClient.request(m, p, t), extras });

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
      if (method === 'GET' && urlPath === '/api/workspace/file') return handleWorkspaceFileRead(req, res, query, workspaceDir);
      if (method === 'PUT' && urlPath === '/api/workspace/file') return await handleWorkspaceFileWrite(req, res, query);
      if (method === 'DELETE' && urlPath === '/api/workspace/file') return handleWorkspaceFileDelete(req, res, query);
      if (method === 'POST' && urlPath === '/api/workspace/upload') return await handleWorkspaceUpload(req, res, query);

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
        extras.setProjectStyle(p.name, { color: body.color, icon: body.icon });
        broadcast(JSON.stringify({ type: 'clawchats', event: 'project-styles-changed' }));
        return send(res, 200, { styles: extras.getProjectStyles() });
      }
      if ((p = matchRoute(method, urlPath, 'DELETE /api/extras/project-styles/:name'))) {
        extras.deleteProjectStyle(p.name);
        broadcast(JSON.stringify({ type: 'clawchats', event: 'project-styles-changed' }));
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
