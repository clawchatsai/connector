import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
export const MAX_PREAMBLE_CHARS = 50000;

// Resolve __dirname for ESM (esbuild inlines this correctly)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function parseConfigField(field) {
  // Try both plugin root and parent of server/ — handles bundled and standalone modes
  const candidates = [path.join(__dirname, 'config.js'), path.join(__dirname, '..', 'config.js')];
  for (const configPath of candidates) {
    try {
      const configText = fs.readFileSync(configPath, 'utf8');
      const match = configText.match(new RegExp(`${field}:\\s*['"]([^'"]+)['"]`));
      if (match) return match[1];
    } catch { /* try next */ }
  }
  return null;
}

// Auth token: config.js → empty (open/unauthenticated mode)
// Note: CLAWCHATS_AUTH_TOKEN env var is read by the plugin host (src/index.ts) and passed via createApp().
export const AUTH_TOKEN = parseConfigField('authToken') || '';

// Gateway WebSocket URL — uses the internal/local gateway address, NOT config.js gatewayUrl
// (that's the browser's external-facing URL and would cause a routing loop through Caddy)
// Note: GATEWAY_WS_URL env var is read by the plugin host (src/index.ts) and passed via createApp().
export function discoverGatewayWsUrl() {
  for (const cfgPath of [path.join(HOME, '.openclaw', 'openclaw.json'), '/etc/openclaw/openclaw.json']) {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const port = raw.gateway?.port || raw.port;
      const host = raw.gateway?.host || raw.host || 'localhost';
      if (port) return `ws://${host}:${port}`;
    } catch { /* try next */ }
  }
  return 'ws://localhost:18789';
}
export const GATEWAY_WS_URL = discoverGatewayWsUrl();

// Sessions directory — where OpenClaw stores session .jsonl files
// Note: OPENCLAW_SESSIONS_DIR env var is read by the plugin host (src/index.ts) and passed via createApp().
export const OPENCLAW_SESSIONS_DIR =
  parseConfigField('sessionsDir') ||
  path.join(HOME, '.openclaw', 'agents', 'main', 'sessions');

// The shape an agent id must have to be safe as a single path segment. Shared with
// validateAgent() below so the two cannot drift apart.
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;

// The agent id here comes from the agent segment of a session_key, and
// parseSessionKey() matches that segment as [^:]+ — which admits `/` and `..`.
// Every caller (gateway-cleanup, thread delete, context preamble) then unlinks or
// reads inside the directory this returns, so an unchecked segment is an arbitrary
// filesystem path. Fall back to the default store rather than throwing: three of the
// four call sites resolve the directory outside their try block, and none of them can
// do anything useful with an exception on what is otherwise a cleanup path.
export function getSessionsDirForAgent(agentId) {
  if (!agentId || agentId === 'main') return OPENCLAW_SESSIONS_DIR;
  if (!AGENT_ID_RE.test(agentId)) {
    console.warn(`getSessionsDirForAgent: refusing unsafe agent id ${JSON.stringify(agentId)}; using the default sessions directory`);
    return OPENCLAW_SESSIONS_DIR;
  }
  return path.join(HOME, '.openclaw', 'agents', agentId, 'sessions');
}

// Resolve a session transcript inside `sessionsDir`, or null when the id cannot be a
// filename. Every id reaching here is interpolated into `${id}.jsonl` and then read or
// unlinked, and they arrive from the gateway session store — a file written by the
// gateway, not by this server. basename() alone would silently rewrite a traversing id
// into something that still resolves; returning null makes the caller skip instead.
//
// This also used to guard `last_session_id`, which POST /api/import stored verbatim.
// CLA-1503 removed that column's callers rather than relying on the guard: refusing a
// traversal never stopped an id naming another thread's transcript inside the store.
export function sessionTranscriptPath(sessionsDir, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (sessionId !== path.basename(sessionId)) {
    console.warn(`sessionTranscriptPath: refusing unsafe session id ${JSON.stringify(sessionId)}`);
    return null;
  }
  return path.join(sessionsDir, `${sessionId}.jsonl`);
}

export function validateAgent(agentId) {
  if (!agentId) return 'main';
  if (!AGENT_ID_RE.test(agentId)) throw new Error('Invalid agent ID');
  const agentDir = path.join(HOME, '.openclaw', 'agents', agentId);
  if (!fs.existsSync(agentDir)) throw new Error(`Agent not found: ${agentId}`);
  return agentId;
}
