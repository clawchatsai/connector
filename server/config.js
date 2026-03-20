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

// Auth token: env var → config.js → empty (open/unauthenticated mode)
export const AUTH_TOKEN = process.env.CLAWCHATS_AUTH_TOKEN || parseConfigField('authToken') || '';

// Gateway WebSocket URL — uses the internal/local gateway address, NOT config.js gatewayUrl
// (that's the browser's external-facing URL and would cause a routing loop through Caddy)
export function discoverGatewayWsUrl() {
  if (process.env.GATEWAY_WS_URL) return process.env.GATEWAY_WS_URL;
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
export const OPENCLAW_SESSIONS_DIR =
  process.env.OPENCLAW_SESSIONS_DIR ||
  parseConfigField('sessionsDir') ||
  path.join(HOME, '.openclaw', 'agents', 'main', 'sessions');

export function getSessionsDirForAgent(agentId) {
  if (!agentId || agentId === 'main') return OPENCLAW_SESSIONS_DIR;
  return path.join(HOME, '.openclaw', 'agents', agentId, 'sessions');
}

export function validateAgent(agentId) {
  if (!agentId) return 'main';
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error('Invalid agent ID');
  const agentDir = path.join(HOME, '.openclaw', 'agents', agentId);
  if (!fs.existsSync(agentDir)) throw new Error(`Agent not found: ${agentId}`);
  return agentId;
}
