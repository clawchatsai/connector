import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();

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

// Agent workspace dir (relative /api/file paths resolve against it): openclaw config → default.
export function discoverWorkspaceDir() {
  for (const cfgPath of [path.join(HOME, '.openclaw', 'openclaw.json'), '/etc/openclaw/openclaw.json']) {
    try {
      const ws = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).agents?.defaults?.workspace;
      if (ws) return ws;
    } catch { /* try next */ }
  }
  return path.join(HOME, '.openclaw', 'workspace');
}
