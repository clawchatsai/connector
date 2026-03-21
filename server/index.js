import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket as WS, WebSocketServer } from 'ws';

import { Database, requestDbStore } from './bootstrap/native.js';
import { GATEWAY_WS_URL, AUTH_TOKEN, getSessionsDirForAgent } from './config.js';
import { DebugLogger } from './debug.js';
import { GatewayClient } from './gateway.js';
import { discoverMemoryConfig } from './providers/memory-config.js';
import { createMemoryProvider } from './providers/memory.js';
import { WorkspaceController } from './controllers/workspaces.js';
import { ThreadController } from './controllers/threads.js';
import { MessageController } from './controllers/messages.js';
import { FileController } from './controllers/files.js';
import { MemoryController } from './controllers/memory.js';
import { handleServeFile, handleWorkspaceList, handleWorkspaceFileRead, handleWorkspaceFileWrite, handleWorkspaceFileDelete, handleWorkspaceUpload } from './controllers/filesystem.js';
import { handleTranscribe } from './controllers/transcribe.js';
import { handleStatic } from './controllers/static.js';
import { handleAgents } from './controllers/agents.js';
import { createSettingsHandlers } from './controllers/settings.js';
import { createWorkspaceStore } from './store/workspace-store.js';
import { parseSessionKey } from './util/helpers.js';
import { send, sendError, parseBody, uuid, matchRoute, setCors } from './util/http.js';

const HOME = os.homedir();
// PORT is passed via createApp(config.port); env var is read by plugin host (src/index.ts).
const DEFAULT_PORT = 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the plugin directory (parent of server/) for static file serving
const PLUGIN_DIR = path.resolve(__dirname, '..');

export function createApp(config = {}) {
  const PORT             = config.port           || DEFAULT_PORT;
  const DATA_DIR         = config.dataDir        || path.join(PLUGIN_DIR, 'data');
  const UPLOADS_DIR      = config.uploadsDir     || path.join(PLUGIN_DIR, 'uploads');
  const WORKSPACES_FILE  = path.join(DATA_DIR, 'workspaces.json');
  const SETTINGS_FILE    = path.join(DATA_DIR, 'settings.json');
  const INTELLIGENCE_DIR = path.join(DATA_DIR, 'intelligence');

  const authToken      = config.authToken    !== undefined ? config.authToken    : AUTH_TOKEN;
  const gatewayToken   = config.gatewayToken !== undefined ? config.gatewayToken : authToken;
  const gatewayUrl     = config.gatewayUrl   || GATEWAY_WS_URL;
  const openaiApiKey   = config.openaiApiKey || null;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  // Per-workspace SQLite databases
  const dbCache = new Map();
  function getDb(workspaceName) {
    if (dbCache.has(workspaceName)) return dbCache.get(workspaceName);
    const db = new Database(path.join(DATA_DIR, `${workspaceName}.db`));
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    dbCache.set(workspaceName, db);
    return db;
  }
  function getActiveDb() { return requestDbStore.getStore() || getDb(getWorkspaces().active); }
  function closeDb(name) { const db = dbCache.get(name); if (db) { db.close(); dbCache.delete(name); } }
  function closeAll() { for (const db of dbCache.values()) db.close(); dbCache.clear(); globalDbCache.close?.(); }

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
  const mediaStash = config.mediaStash ?? new Map();

  const memoryConfig = discoverMemoryConfig(config.memoryEnv || {});
  const memoryProvider = createMemoryProvider(memoryConfig);
  memoryProvider.init().catch(err => console.error('[createApp] Memory provider init error:', err.message));
  const MEMORY_FILES_DIR = path.join(memoryConfig.workspaceDir, 'memory');

  // Instantiate the gateway client with all dependencies injected
  const gatewayClient = new GatewayClient({ getDb, getWorkspaces, dataDir: DATA_DIR, debugLogger, gatewayWsUrl: gatewayUrl, authToken: gatewayToken, mediaStash });
  const broadcast = msg => gatewayClient.broadcastToBrowsers(msg);

  // Instantiate controllers
  const workspaces = new WorkspaceController({ getDb, closeDb, getWorkspaces, setWorkspaces, dataDir: DATA_DIR, broadcast });
  const threads    = new ThreadController({ getActiveDb, getWorkspaces, uploadsDir: UPLOADS_DIR, broadcast });
  const messages   = new MessageController({ getActiveDb, getWorkspaces, broadcast });
  const files      = new FileController({ getActiveDb, getWorkspaces, uploadsDir: UPLOADS_DIR, intelligenceDir: INTELLIGENCE_DIR });
  const memory     = new MemoryController({ memoryProvider, memoryFilesDir: MEMORY_FILES_DIR, memoryConfig });

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
    const wsName = req.headers?.['x-workspace'];
    const db = wsName ? getDb(wsName) : getActiveDb();
    return requestDbStore.run(db, () => route(req, res));
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
    if ((p = matchRoute(method, urlPath, 'GET /api/uploads/:threadId/:fileId'))) return files.serveUpload(req, res, p);

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
      if (method === 'GET' && urlPath === '/api/file') return handleServeFile(req, res, query, memoryConfig);
      if (method === 'GET' && urlPath === '/api/workspace') return handleWorkspaceList(req, res, query);
      if (method === 'GET' && urlPath === '/api/workspace/file') return handleWorkspaceFileRead(req, res, query);
      if (method === 'PUT' && urlPath === '/api/workspace/file') return await handleWorkspaceFileWrite(req, res, query);
      if (method === 'DELETE' && urlPath === '/api/workspace/file') return handleWorkspaceFileDelete(req, res, query);
      if (method === 'POST' && urlPath === '/api/workspace/upload') return await handleWorkspaceUpload(req, res, query);

      // Memory
      if (method === 'GET' && urlPath === '/api/memory/status') return await memory.status(req, res);
      if (method === 'GET' && urlPath === '/api/memory/list') return await memory.list(req, res, query);
      if (method === 'GET' && urlPath === '/api/memory/search') return await memory.search(req, res, query);
      if (method === 'GET' && urlPath === '/api/memory/files') return memory.files(req, res, query);
      if ((p = matchRoute(method, urlPath, 'PUT /api/memory/:id'))) return await memory.update(req, res, p);
      if ((p = matchRoute(method, urlPath, 'DELETE /api/memory/:id'))) return await memory.delete(req, res, p);

      // Settings & misc
      if (method === 'GET' && urlPath === '/api/settings') return handleGetSettings(req, res);
      if (method === 'PUT' && urlPath === '/api/settings') return await handleSaveSettings(req, res, parseBody);
      if (method === 'POST' && urlPath === '/api/transcribe') return await handleTranscribe(req, res, { openaiApiKey });
      if (method === 'GET' && urlPath === '/api/health') return send(res, 200, { ok: true, workspace: getWorkspaces().active, uptime: process.uptime() });
      if (method === 'GET' && urlPath === '/api/agents') return handleAgents(req, res);

      // Workspaces
      if (method === 'GET' && urlPath === '/api/workspaces') return workspaces.getAll(req, res);
      if (method === 'POST' && urlPath === '/api/workspaces') return await workspaces.create(req, res);
      if ((p = matchRoute(method, urlPath, 'PATCH /api/workspaces/:name'))) return await workspaces.update(req, res, p);
      if ((p = matchRoute(method, urlPath, 'DELETE /api/workspaces/:name'))) return workspaces.delete(req, res, p);
      if (method === 'POST' && urlPath === '/api/workspaces/reorder') return await workspaces.reorder(req, res);
      if ((p = matchRoute(method, urlPath, 'POST /api/workspaces/:name/activate'))) return workspaces.activate(req, res, p);

      // Threads
      if (method === 'GET' && urlPath === '/api/threads') return threads.getAll(req, res, {}, query);
      if (method === 'GET' && urlPath === '/api/threads/unread') return threads.getUnread(req, res);
      if (method === 'POST' && urlPath === '/api/threads') return await threads.create(req, res);
      if ((p = matchRoute(method, urlPath, 'POST /api/threads/:id/mark-read'))) return await threads.markRead(req, res, p);
      if ((p = matchRoute(method, urlPath, 'GET /api/threads/:id/messages'))) return messages.getAll(req, res, p, query);
      if ((p = matchRoute(method, urlPath, 'POST /api/threads/:id/messages'))) return await messages.create(req, res, p);
      if ((p = matchRoute(method, urlPath, 'DELETE /api/threads/:id/messages/:messageId'))) return messages.delete(req, res, p);
      if ((p = matchRoute(method, urlPath, 'POST /api/threads/:id/context-fill'))) return messages.contextFill(req, res, p);
      if ((p = matchRoute(method, urlPath, 'POST /api/threads/:id/generate-title'))) {
        const db = getActiveDb();
        const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(p.id);
        if (!thread) return sendError(res, 404, 'Thread not found');
        gatewayClient.generateThreadTitle(db, p.id, getWorkspaces().active);
        return send(res, 200, { ok: true });
      }
      if ((p = matchRoute(method, urlPath, 'POST /api/threads/:id/upload'))) return await files.upload(req, res, p);
      if ((p = matchRoute(method, urlPath, 'GET /api/threads/:id/intelligence'))) return files.getIntelligence(req, res, p);
      if ((p = matchRoute(method, urlPath, 'POST /api/threads/:id/intelligence'))) return await files.saveIntelligence(req, res, p);
      if ((p = matchRoute(method, urlPath, 'GET /api/threads/:id'))) return threads.get(req, res, p);
      if ((p = matchRoute(method, urlPath, 'PATCH /api/threads/:id'))) return await threads.update(req, res, p);
      if ((p = matchRoute(method, urlPath, 'DELETE /api/threads/:id'))) return threads.delete(req, res, p);

      // Search / export / import
      if (method === 'GET' && urlPath === '/api/search') return messages.search(req, res, {}, query);
      if (method === 'GET' && urlPath === '/api/export') return messages.export(req, res);
      if (method === 'POST' && urlPath === '/api/import') return await messages.import(req, res);

      if (method === 'POST' && urlPath === '/api/active-thread') {
        const body = await parseBody(req);
        if (body.threadId && body.workspace) gatewayClient.setActiveThread(null, body.workspace, body.threadId);
        return send(res, 200, { ok: true });
      }

      sendError(res, 404, `Not found: ${method} ${urlPath}`);
    } catch (err) {
      console.error(`Error handling ${method} ${urlPath}:`, err);
      if (err.message?.includes('UNIQUE constraint')) sendError(res, 409, 'Conflict: ' + err.message);
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
        let msgToForward = msgStr;
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
            if (msg.action === 'active-thread') { gatewayClient.setActiveThread(ws, msg.workspace, msg.threadId); return; }
            if (msg.action === 'debug-start') { const r = debugLogger.start(msg.ts, ws); ws.send(JSON.stringify(r.error === 'already-active' ? { type: 'clawchats', event: 'debug-error', error: 'Recording already active in another tab', sessionId: r.sessionId } : { type: 'clawchats', event: 'debug-started', sessionId: r.sessionId })); return; }
            if (msg.action === 'debug-dump') { const r = debugLogger.saveDump(msg); ws.send(JSON.stringify({ type: 'clawchats', event: 'debug-saved', sessionId: r.sessionId, files: r.files })); return; }
          }
          // Save inline attachments to disk before forwarding to gateway
          if (msg.type === 'req' && msg.method === 'chat.send' && msg.params?.attachments?.length > 0) {
            const parsed = parseSessionKey(msg.params.sessionKey || '');
            const threadId = parsed?.threadId || 'misc';
            const uploadDir = path.join(UPLOADS_DIR, threadId);
            fs.mkdirSync(uploadDir, { recursive: true });
            const extMap = { jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', pdf: 'pdf', 'svg+xml': 'svg', mp3: 'mp3', mp4: 'mp4', wav: 'wav', webm: 'webm' };
            const savedPaths = [];
            for (const att of msg.params.attachments) {
              if (!att.content || !att.mimeType) continue;
              try {
                const rawExt = att.mimeType.split('/')[1]?.split(';')[0] || 'bin';
                const filePath = path.join(uploadDir, `${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${extMap[rawExt] || rawExt}`);
                fs.writeFileSync(filePath, Buffer.from(att.content, 'base64'));
                savedPaths.push(filePath);
              } catch (err) { console.error('[upload] Failed to save attachment:', err.message); }
            }
            if (savedPaths.length > 0) {
              const note = `\n\n[${savedPaths.length === 1 ? 'Attached file saved on disk' : 'Attached files saved on disk'}:\n${savedPaths.map(p => `- ${p}`).join('\n')}]`;
              msgToForward = JSON.stringify({ ...msg, params: { ...msg.params, message: (msg.params.message || '') + note } });
            }
          }
        } catch { /* not JSON or not a ClawChats message, forward as-is */ }
        gatewayClient.sendToGateway(msgToForward);
      });

      ws.on('close', () => { console.log('Browser client disconnected'); debugLogger.handleClientDisconnect(ws); gatewayClient.removeBrowserClient(ws); });
      ws.on('error', err => console.error('Browser WebSocket error:', err.message));
    });
  }

  return {
    handleRequest,
    getDb,
    getActiveDb,
    getWorkspaces,
    setWorkspaces,
    shutdown: closeAll,
    closeAllDbs: closeAll,
    gatewayClient,
    setupBrowserWs,
    dataDir: DATA_DIR,
  };
}

// Migration — kept here as it references Database-level constructs shared across modules
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, session_key TEXT UNIQUE NOT NULL, title TEXT DEFAULT 'New chat',
      pinned INTEGER DEFAULT 0, pin_order INTEGER DEFAULT 0, model TEXT,
      last_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT DEFAULT 'sent', metadata TEXT, seq INTEGER, timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_dedup ON messages(thread_id, role, timestamp);
  `);
  try { db.exec('ALTER TABLE threads ADD COLUMN sort_order INTEGER DEFAULT 0'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE threads ADD COLUMN unread_count INTEGER DEFAULT 0'); } catch { /* exists */ }
  db.exec(`CREATE TABLE IF NOT EXISTS unread_messages (thread_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (thread_id, message_id), FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_unread_thread ON unread_messages(thread_id)');
  ensureFts(db);
}

function createFts(db) {
  db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(content, content=messages, content_rowid=rowid, tokenize='porter unicode61 tokenchars x27')`);
  db.exec(`CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END`);
  db.exec(`CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content); END`);
  db.exec(`CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content); INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END`);
}

function dropFts(db) {
  db.exec('DROP TABLE IF EXISTS messages_fts; DROP TRIGGER IF EXISTS messages_ai; DROP TRIGGER IF EXISTS messages_ad; DROP TRIGGER IF EXISTS messages_au;');
}

function ensureFts(db) {
  const hasFts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get();
  if (!hasFts) {
    try { createFts(db); db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run(); }
    catch (e) { console.error('[DB] messages_fts creation failed:', e.message); }
    return;
  }
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'").get();
  if (schema && !schema.sql.includes('tokenchars')) {
    console.log('[DB] Upgrading messages_fts tokenizer...');
    try { dropFts(db); createFts(db); db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run(); console.log('[DB] Upgrade complete'); }
    catch (e) { console.error('[DB] Upgrade failed:', e.message); dropFts(db); }
  } else {
    try { db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run(); }
    catch { try { db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run(); } catch (e) { console.error('[DB] FTS rebuild failed:', e.message); dropFts(db); } }
  }
}

// Standalone mode (node server/index.js or via isDirectRun check in bundle)
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const app = createApp();
  app.getActiveDb();

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
