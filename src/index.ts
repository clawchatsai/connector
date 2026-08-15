/**
 * @clawchatsai/connector — OpenClaw plugin entry point
 *
 * Registers ClawChats as a gateway plugin, providing:
 * - Local HTTP API bridge via createApp()
 * - WebRTC DataChannel for browser connections
 * - Signaling client for NAT traversal
 * - Gateway bridge for local OpenClaw communication
 *
 * Spec: specs/multitenant-p2p.md sections 6.1-6.2
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { PluginConfig } from './gateway-bridge.js';
import { SignalingClient } from './signaling-client.js';
// Lazy-imported after ensureNativeModules() builds the native binary.
// Top-level import would crash because node-datachannel .node file doesn't exist yet
// when OpenClaw installs with --ignore-scripts.
import type { DataChannelLike } from './webrtc-peer.js';
type WebRTCPeerManagerType = import('./webrtc-peer.js').WebRTCPeerManager;
import { dispatchRpc, type RpcRequest } from './shim.js';

import { initAuth, handleAuthMessage, cleanupAuth, isAuthenticated, type AuthConfig } from './auth-handler.js';
import { generateTotpSecret, verifyTotp, generateBackupCodes, buildOtpauthUri } from './totp.js';
import { generateSessionSecret } from './session-token.js';
import { fileURLToPath } from 'node:url';
// ESM __dirname polyfill (package.json has "type":"module")
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Inline from shared/api-version.ts to avoid rootDir conflict
const CURRENT_API_VERSION = 1;

export const PLUGIN_ID = 'connector';
// Read version from package.json so it stays in sync with npm publishes
const _pkgJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));
export const PLUGIN_VERSION: string = _pkgJson.version;

// ---------------------------------------------------------------------------
// Module-level state shared between start/stop lifecycle functions
// ---------------------------------------------------------------------------

/** Minimal type for the object returned by server.js createApp() */
interface AppInstance {
  handleRequest: (req: unknown, res: unknown) => void | Promise<void>;
  getDb: (workspace: string) => unknown;
  getActiveDb: () => unknown;
  getWorkspaces: () => { active: string; workspaces: Record<string, unknown> };
  setWorkspaces: (data: unknown) => void;
  shutdown: () => void;
  closeAllDbs: () => void;
  gatewayClient: {
    connect: () => void;
    connected: boolean;
    sendToGateway: (data: string) => void;
    addBroadcastTarget: (fn: (data: string) => void) => void;
    removeBroadcastTarget: (fn: (data: string) => void) => void;
  };
  setupBrowserWs: (wss: unknown) => void;
  debugLogger: {
    start: (ts: string, originatingClient: unknown) => { sessionId: string | null; error?: string };
    saveDump: (payload: Record<string, unknown>) => { sessionId: string | null; files: string[] };
    handleClientDisconnect: (ws: unknown) => void;
  };
  dataDir: string;
}

/** Max DataChannel message size (~256KB, leave room for envelope) */
const MAX_DC_MESSAGE_SIZE = 256 * 1024;

/** Active DataChannel connections: connectionId → send function */
const connectedClients = new Map<string, { send: (data: string) => void }>();

/** Reassembly buffers for chunked RPC requests from browser (large uploads). */
const rpcReqChunkBuffers = new Map<string, {
  chunks: string[];
  received: number;
  total: number;
  createdAt: number;
}>();

/** Reassembly buffers for chunked gateway-msg from browser (large payloads like image attachments). */
const gatewayMsgChunkBuffers = new Map<string, {
  chunks: string[];
  received: number;
  total: number;
  createdAt: number;
}>();

let app: AppInstance | null = null;
let signaling: SignalingClient | null = null;
let webrtcPeer: WebRTCPeerManagerType | null = null;
let healthServer: http.Server | null = null;
let _stopRequested = false;

/** Model IDs that have 'input' explicitly set without 'image' support. */
let _imageRestrictedModels: string[] = [];
/** True if session.reset config risks wiping ClawChats history (daily reset or short idle). */
let _sessionResetWarning = false;
let _uploadsDir: string | null = null;

// ---------------------------------------------------------------------------
// Types for OpenClaw plugin API (minimal — these come from the plugin SDK)
// ---------------------------------------------------------------------------

interface PluginServiceContext {
  stateDir: string;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  _forceUpdate?: boolean;
}

interface PluginCliContext {
  program: {
    command: (name: string) => {
      description: (desc: string) => CliCommand;
      command: (nameAndArgs: string) => CliCommand;
    };
  };
}

interface CliCommand {
  description: (desc: string) => CliCommand;
  action: (handler: (...args: unknown[]) => void | Promise<void>) => CliCommand;
  command: (nameAndArgs: string) => CliCommand;
}

interface PluginApi {
  registerService: (opts: {
    id: string;
    start: (ctx: PluginServiceContext) => Promise<void>;
    stop: (ctx: PluginServiceContext) => Promise<void>;
  }) => void;
  registerCli: (handler: (ctx: PluginCliContext) => void, opts?: { commands?: string[] }) => void;
  registerCommand: (opts: {
    name: string;
    description: string;
    handler: () => { text: string };
  }) => void;
  registerHook: (
    events: string | string[],
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => void | Promise<void>,
    opts: { name: string; description?: string }
  ) => void;
  on: (
    hookName: string,
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>,
    opts?: { name?: string; description?: string; priority?: number }
  ) => void;
  runtime: {
    requestRestart?: (reason: string) => void;
  };
  config?: Record<string, unknown>;
}

interface OpenClawPluginDefinition {
  id: string;
  name: string;
  description: string;
  register: (api: PluginApi) => void;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), '.openclaw', 'clawchats');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const RUNTIME_FILE = path.join(CONFIG_DIR, 'runtime.json');

function loadConfig(): PluginConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(raw) as PluginConfig;
    if (!cfg.userId || !cfg.apiKey || !cfg.serverUrl) {
      return null;
    }
    return cfg;
  } catch {
    return null;
  }
}

function saveConfig(config: PluginConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

/**
 * Detect musl libc (Alpine Linux) vs glibc.
 * prebuildify/prebuild-install distinguishes linux vs linuxmusl.
 */
function detectLinuxLibc(): 'musl' | 'glibc' {
  try {
    const ldd = fs.readFileSync('/usr/bin/ldd', 'utf8');
    if (ldd.includes('musl')) return 'musl';
  } catch { /* not found */ }
  try {
    if (fs.readdirSync('/lib').some((f: string) => f.startsWith('libc.musl'))) return 'musl';
  } catch { /* not found */ }
  return 'glibc';
}

/**
 * Returns the prebuild key for the current platform, matching the directory
 * names we bundle under prebuilds/ (e.g. "linux-x64", "linuxmusl-arm64").
 */
function getPrebuildKey(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'linux' && detectLinuxLibc() === 'musl') return `linuxmusl-${arch}`;
  return `${platform}-${arch}`;
}

/**
 * Resolve a package's install root without relying on subpath access to its
 * package.json. Node treats an "exports" map as an allowlist, so
 * require.resolve('<pkg>/package.json') throws for any package that does not
 * explicitly export it. Resolving the main entry is always permitted, so walk
 * up from there to the directory named after the package.
 */
function resolvePackageRoot(require: NodeRequire, pkgName: string): string | undefined {
  let entry: string;
  try {
    entry = require.resolve(pkgName);
  } catch {
    return undefined;
  }
  const marker = `${path.sep}${pkgName}${path.sep}`;
  const idx = entry.lastIndexOf(marker);
  if (idx === -1) return undefined;
  return entry.slice(0, idx + marker.length - 1);
}

async function ensureNativeModules(ctx: PluginServiceContext): Promise<void> {
  const pluginDir = path.resolve(__dirname, '..');

  // Resolve node-datachannel's actual install root (handles npm hoisting).
  // Writing to <pluginDir>/node_modules/node-datachannel/ would create a
  // package-shaped directory that lacks package.json + JS, shadowing the
  // hoisted copy and breaking subpath imports like 'node-datachannel/polyfill'.
  //
  // Resolve via the package's main entry, NOT 'node-datachannel/package.json':
  // node-datachannel's exports map declares only "." and "./polyfill", so asking
  // for the package.json subpath always throws ERR_PACKAGE_PATH_NOT_EXPORTED.
  // That made this function bail out before copying anything on every install;
  // it only appeared to work where a binary already existed from a source build.
  const require = createRequire(import.meta.url);
  const ndcRoot = resolvePackageRoot(require, 'node-datachannel');
  if (!ndcRoot) {
    ctx.logger.error('[clawchats] node-datachannel package not resolvable; WebRTC unavailable.');
    return;
  }
  const targetPath = path.join(ndcRoot, 'build', 'Release', 'node_datachannel.node');

  // Already built — nothing to do.
  if (fs.existsSync(targetPath)) return;

  // Find the bundled prebuilt for this platform (shipped inside the npm package).
  const prebuildKey = getPrebuildKey();
  const prebuiltPath = path.join(pluginDir, 'prebuilds', prebuildKey, 'node_datachannel.node');

  if (!fs.existsSync(prebuiltPath)) {
    ctx.logger.error(
      `[clawchats] No prebuilt binary for ${prebuildKey}. ` +
      `WebRTC will be unavailable. To fix manually: ` +
      `cd ~/.openclaw/extensions/connector && npm rebuild node-datachannel`,
    );
    return;
  }

  ctx.logger.info(`[clawchats] Installing node-datachannel prebuilt for ${prebuildKey}...`);
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(prebuiltPath, targetPath);
    ctx.logger.info('[clawchats] node-datachannel ready.');
  } catch (e) {
    // Surface the manual remedy: the service import fails moments later with an
    // opaque "Cannot find module '../../../build/Release/node_datachannel.node'",
    // which says nothing about what to actually do.
    ctx.logger.error(
      `[clawchats] Failed to install prebuilt: ${(e as Error).message}\n` +
      `  To fix manually:\n    mkdir -p ${path.dirname(targetPath)}\n` +
      `    cp ${prebuiltPath} ${targetPath}`,
    );
  }
}

const CLAWCHATS_MD_CONTENT = `# ClawChats — Inline File Delivery

To deliver a file inline in this chat, run an exec that outputs a MEDIA: line:

    MEDIA:/absolute/path/to/file

**After creating any file** (via Write tool or exec), deliver it by running:

    exec echo "MEDIA:/absolute/path/to/file"

For files created during an exec command, you can inline it at the end of the same command:

    exec python3 generate.py --output /tmp/result.png && echo "MEDIA:/tmp/result.png"

Notes:
- Works for images (png, jpg, gif, webp, svg, etc.), documents, markdown, code files, and more
- Output each path once — duplicates are ignored automatically
`;

async function startClawChats(ctx: PluginServiceContext, api: PluginApi): Promise<void> {
  _stopRequested = false;

  // Bootstrap CLAWCHATS.md in the agent workspace so the agent always knows the MEDIA: protocol.
  // Written once on plugin start; never overwrites an existing file (user may have customised it).
  try {
    const workspaceDir = path.join(ctx.stateDir, 'workspace');
    const clawchatsDoc = path.join(workspaceDir, 'CLAWCHATS.md');
    if (!fs.existsSync(clawchatsDoc)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(clawchatsDoc, CLAWCHATS_MD_CONTENT, { encoding: 'utf8' });
      ctx.logger.info('[clawchats] wrote CLAWCHATS.md to workspace');
    }
  } catch (e) {
    ctx.logger.warn(`[clawchats] could not write CLAWCHATS.md: ${(e as Error).message}`);
  }

  let config = loadConfig();

  if (!config) {
    ctx.logger.info('ClawChats not configured. Waiting for setup...');
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    while (!config && !_stopRequested) {
      await new Promise(r => setTimeout(r, 2000));
      config = loadConfig();
    }
    if (_stopRequested || !config) return;
    ctx.logger.info('Setup detected — connecting to ClawChats...');
  }

  // 1. Resolve gateway token: runtime API → config file → error
  const gwCfg = api.config as Record<string, unknown> | undefined;
  const gwAuth = (gwCfg?.['gateway'] as Record<string, unknown> | undefined)?.['auth'] as Record<string, unknown> | undefined;
  const gatewayToken = (gwAuth?.['token'] as string | undefined) || config.gatewayToken || '';

  if (!gatewayToken) {
    ctx.logger.error('No gateway token available. Re-run: openclaw clawchats setup <token>');
    return;
  }

  // Check session.reset config — warn if daily reset or short idle could wipe ClawChats history.
  _sessionResetWarning = false;
  try {
    const sessionReset = (gwCfg?.['session'] as Record<string, unknown> | undefined)?.['reset'] as Record<string, unknown> | undefined;
    if (sessionReset) {
      const mode = sessionReset['mode'] as string | undefined;
      const idleMinutes = sessionReset['idleMinutes'] as number | undefined;
      if (mode === 'daily' || (mode === 'idle' && typeof idleMinutes === 'number' && idleMinutes < 43200)) {
        _sessionResetWarning = true;
        ctx.logger.warn(`[clawchats] session.reset may wipe chat history (mode=${mode}, idleMinutes=${idleMinutes ?? 'unset'}) — set mode=idle + idleMinutes=999999`);
      }
    }
  } catch {
    // Non-fatal
  }

  // Check for model definitions with 'input' set but missing 'image' — they silently drop attachments.
  _imageRestrictedModels = [];
  try {
    const providers = (gwCfg?.['models'] as Record<string, unknown> | undefined)?.['providers'] as Record<string, { models?: Array<{ id?: string; input?: string[] }> }> | undefined ?? {};
    for (const provider of Object.values(providers)) {
      if (Array.isArray(provider.models)) {
        for (const m of provider.models) {
          if (Array.isArray(m.input) && !m.input.includes('image')) {
            _imageRestrictedModels.push(m.id ?? '(unknown)');
          }
        }
      }
    }
    if (_imageRestrictedModels.length > 0) {
      ctx.logger.warn(`[clawchats] image-restricted models detected (missing "image" input): ${_imageRestrictedModels.join(', ')}`);
    }
  } catch {
    // Non-fatal: config parse issue, just skip the check
  }

  // 3. Ensure native modules are built (OpenClaw installs with --ignore-scripts)
  await ensureNativeModules(ctx);

  // 4. Import server.js and create app instance with plugin paths
  const dataDir = path.join(ctx.stateDir, 'clawchats', 'data');
  const uploadsDir = path.join(ctx.stateDir, 'clawchats', 'uploads');
  _uploadsDir = uploadsDir;
  // Dynamic import of server.js (plain JS, no type declarations)
  // @ts-expect-error — server/index.js is plain JS with no .d.ts
  const serverModule: { createApp: (config: Record<string, unknown>) => AppInstance } = await import('../server/index.js');
  // Read env vars here (plugin host) so server/ bundle stays process.env-free.
  const memoryEnv = {
    provider:   process.env.MEMORY_PROVIDER,
    host:       process.env.MEMORY_HOST   || process.env.QDRANT_HOST,
    port:       process.env.MEMORY_PORT   || process.env.QDRANT_PORT,
    collection: process.env.MEMORY_COLLECTION || process.env.QDRANT_COLLECTION,
    pgUrl:      process.env.MEMORY_PG_URL,
    qdrantUrl:  process.env.QDRANT_URL,
  };
  // Filter out undefined values so discoverMemoryConfig only overrides what's set.
  const memoryEnvFiltered = Object.fromEntries(
    Object.entries(memoryEnv).filter(([, v]) => v !== undefined && v !== ''),
  );

  app = serverModule.createApp({
    dataDir,
    uploadsDir,
    port:          parseInt(process.env.PORT || '3001', 10),
    gatewayUrl:    process.env.GATEWAY_WS_URL || 'ws://localhost:18789',
    authToken:     process.env.CLAWCHATS_AUTH_TOKEN || '', // P2P: DataChannel is the auth boundary
    gatewayToken,  // For WS auth to local OpenClaw gateway
    openaiApiKey:  (() => {
      // Resolve OpenAI API key: openclaw config → env var
      try {
        const oc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
        const fromConfig = oc?.skills?.entries?.['openai-whisper-api']?.apiKey;
        if (fromConfig) return fromConfig;
      } catch { /* ok */ }
      return process.env.OPENAI_API_KEY || null;
    })(),
    memoryEnv:     memoryEnvFiltered,
  });

  // 4. Connect createApp's gateway client (handles persistence + event relay)
  app.gatewayClient.connect();

  // Wire DataChannel clients as broadcast targets so they receive gateway events
  app.gatewayClient.addBroadcastTarget((data: string) => {
    for (const [id, client] of connectedClients) {
      try {
        client.send(JSON.stringify({ type: 'gateway-event', payload: data }));
      } catch {
        connectedClients.delete(id);
      }
    }
  });

  // 5. Connect to signaling server
  const _hostname = os.hostname();
  signaling = new SignalingClient(config.serverUrl, config.userId, config.apiKey, {
    gatewayId: config.gatewayId,
    hostname: _hostname,
  });

  signaling.on('connected', () => {
    ctx.logger.info('Connected to signaling server');
  });

  signaling.on('auth-rejected', (reason: string) => {
    ctx.logger.error(`Signaling auth rejected: ${reason}`);
  });

  // version-rejected listener removed — version check is now client-side

  signaling.on('account-suspended', (reason: string) => {
    ctx.logger.error(`Account suspended: ${reason}`);
    broadcastToClients({ type: 'account-suspended', reason });
  });

  // 6. Initialize WebRTC peer manager (lazy import — native module must be built first)
  const { WebRTCPeerManager } = await import('./webrtc-peer.js');
  webrtcPeer = new WebRTCPeerManager();

  webrtcPeer.on('datachannel', (dc: DataChannelLike, connectionId: string) => {
    ctx.logger.info(`Browser connected via DataChannel: ${connectionId}`);
    setupDataChannelHandler(dc, connectionId, ctx);
    signaling?.reportConnectionCount(webrtcPeer?.activeCount ?? 0);
  });

  webrtcPeer.on('datachannel-closed', (connectionId: string) => {
    ctx.logger.info(`Browser disconnected: ${connectionId}`);
    connectedClients.delete(connectionId);
    signaling?.reportConnectionCount(webrtcPeer?.activeCount ?? 0);
  });

  // Wire signaling ICE events to peer manager
  signaling.on('ice-offer', async (offer: { connectionId: string; sdp: string; candidates: unknown[] }) => {
    if (!webrtcPeer) return;
    try {
      const answer = await webrtcPeer.handleOffer(offer);
      signaling?.sendIceAnswer(answer.connectionId, answer.sdp, answer.candidates);
    } catch (e) {
      ctx.logger.error(`ICE offer handling failed: ${(e as Error).message}`);
    }
  });

  // ICE servers arrive before offers — buffer them
  signaling.on('ice-servers', (data: { connectionId: string; iceServers: Array<{ urls: string }> }) => {
    webrtcPeer?.setIceServers(data);
  });

  // Trickle ICE candidates from browser → plugin
  signaling.on('ice-candidate', (data: { connectionId: string; candidate: unknown }) => {
    webrtcPeer?.handleIceCandidate(data.connectionId, data.candidate);
  });

  // Trickle ICE candidates from plugin → browser
  webrtcPeer.on('ice-candidate-local', (data: { connectionId: string; candidate: unknown }) => {
    signaling?.sendIceCandidate(data.connectionId, data.candidate);
  });

  await signaling.connect();

  // 7. Start health endpoint for CLI status queries
  healthServer = http.createServer((req, res) => {
    if (req.url === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: PLUGIN_VERSION,
        pid: process.pid,
        uptime: process.uptime(),
        gateway: { connected: app?.gatewayClient?.connected ?? false },
        signaling: { connected: signaling?.isConnected ?? false },
        clients: { active: connectedClients.size },
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  healthServer.listen(0, '127.0.0.1', () => {
    const addr = healthServer!.address() as net.AddressInfo;
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify({
      pid: process.pid,
      healthPort: addr.port,
      startedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    ctx.logger.info(`Health endpoint on 127.0.0.1:${addr.port}`);
  });

  ctx.logger.info('ClawChats service started');
}

async function stopClawChats(ctx: PluginServiceContext): Promise<void> {
  _stopRequested = true;
  ctx.logger.info('ClawChats service stopping...');

  // 0. Tear down health endpoint
  if (healthServer) { healthServer.close(); healthServer = null; }
  try { fs.unlinkSync(RUNTIME_FILE); } catch { /* already gone */ }

  // 1. Notify connected browsers and close DataChannels
  for (const [id, client] of connectedClients) {
    try {
      client.send(JSON.stringify({ type: 'gateway-shutdown' }));
    } catch { /* already closed */ }
    connectedClients.delete(id);
  }

  // 2. Close all WebRTC peer connections
  webrtcPeer?.closeAll();
  webrtcPeer = null;

  // 3. Disconnect from signaling server
  signaling?.disconnect();
  signaling = null;

  // 4. Close SQLite databases
  app?.shutdown();
  app = null;

  ctx.logger.info('ClawChats service stopped');
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Gateway payload normalization
// ---------------------------------------------------------------------------

/**
 * Normalize gateway-bound payloads before forwarding.
 *
 * Fixes image-only messages: some OpenClaw versions reject chat.send when
 * the message body is empty, even if attachments are present (the empty-body
 * guard checks MediaPath/MediaPaths but not inline base64 attachments).
 * Injecting a minimal placeholder ensures the agent run proceeds.
 */
// Track which ClawChats thread sessions have received the capability note (once per session).


function normalizeGatewayPayload(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed.method === 'chat.send' && typeof parsed.params?.message === 'string') {
      // Warn user in-chat if they're sending image attachments to an image-restricted model.
      // The warning is appended to the message so the AI echoes it back — impossible to miss.
      if (
        Array.isArray(parsed.params?.attachments) &&
        parsed.params.attachments.length > 0 &&
        _imageRestrictedModels.length > 0
      ) {
        parsed.params.message = (parsed.params.message || '').trimEnd() +
          '\n\n[⚠️ ClawChats: image attachment not delivered — your model config is missing "image" input support. ' +
          'Fix: add "image" to the input array for your model in ~/.openclaw/openclaw.json, then restart the gateway.]';
        return JSON.stringify(parsed);
      }

      // Fix image-only messages: inject placeholder so gateway doesn't reject empty body.
      if (
        Array.isArray(parsed.params?.attachments) &&
        parsed.params.attachments.length > 0 &&
        !parsed.params.message?.trim()
      ) {
        parsed.params.message = '[Image]';
        return JSON.stringify(parsed);
      }

      // Save inline base64 attachments to disk so the agent can reference them as file paths.
      // Runs before capability note so a gateway restart doesn't prevent path injection.
      if (Array.isArray(parsed.params?.attachments) && parsed.params.attachments.length > 0 && _uploadsDir) {
        const skMatch = (parsed.params.sessionKey as string || '').match(/^agent:[^:]+:[^:]+:chat:([^:]+)$/);
        const threadId = skMatch?.[1] || 'misc';
        const uploadDir = path.join(_uploadsDir, threadId);
        const extMap: Record<string, string> = { jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', pdf: 'pdf', 'svg+xml': 'svg', mp3: 'mp3', mp4: 'mp4', wav: 'wav', webm: 'webm' };
        const savedPaths: string[] = [];
        for (const att of parsed.params.attachments) {
          if (!att.content || !att.mimeType) continue;
          try {
            const rawExt = (att.mimeType as string).split('/')[1]?.split(';')[0] || 'bin';
            const ext = extMap[rawExt] || rawExt;
            const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const filePath = path.join(uploadDir, `${fileId}.${ext}`);
            fs.mkdirSync(uploadDir, { recursive: true });
            fs.writeFileSync(filePath, Buffer.from(att.content as string, 'base64'));
            savedPaths.push(filePath);
          } catch { /* skip attachment on error */ }
        }
        if (savedPaths.length > 0) {
          const label = savedPaths.length === 1 ? 'Attached file saved on disk' : 'Attached files saved on disk';
          parsed.params.message = (parsed.params.message as string).trimEnd() +
            `\n\n[${label}:\n${savedPaths.map((p: string) => `- ${p}`).join('\n')}]`;
          return JSON.stringify(parsed);
        }
      }


    }
  } catch {
    // Not JSON or unexpected shape — pass through unchanged
  }
  return raw;
}

// DataChannel message handler (spec section 6.4)
// ---------------------------------------------------------------------------

function setupDataChannelHandler(
  dc: DataChannelLike,
  connectionId: string,
  ctx: PluginServiceContext,
): void {
  // Build auth config from plugin config
  const config = loadConfig();
  const isDevMode = process.env.CLAWCHATS_DEV === 'true';
  const hasGoogle = !!config?.google;
  const authEnabled = config?.schemaVersion === 2 && config?.totp && config?.sessionSecret;

  if (authEnabled) {
    // In dev mode without Google identity, use placeholder
    const google = config!.google ?? {
      clientId: 'dev-placeholder',
      authorizedSub: 'dev-placeholder',
      authorizedEmail: 'dev@localhost',
    };

    // Auth-gated: don't add to broadcast clients until authenticated
    const authConfig: AuthConfig = {
      userId: config!.userId,
      totp: config!.totp!,
      google,
      sessionSecret: config!.sessionSecret!,
      backupCodeHashes: config!.backupCodeHashes,
      devMode: isDevMode,
    };

    const authStarted = initAuth(dc, connectionId);
    if (!authStarted) return; // rate-limited, DC will be closed

    dc.onMessage(async (data: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data);
      } catch {
        dc.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      // Check auth state
      const authResult = await handleAuthMessage(dc, connectionId, msg, authConfig);

      switch (authResult) {
        case 'authenticated':
          // Auth succeeded — add to broadcast clients and inform gateway
          connectedClients.set(connectionId, dc);
          ctx.logger.info(`Browser authenticated: ${connectionId}`);

          // Warn if any models have image support disabled in openclaw.json
          if (_imageRestrictedModels.length > 0) {
            dc.send(JSON.stringify({
              type: 'gateway-event',
              payload: JSON.stringify({ type: 'clawchats', event: 'image-capability-warning', models: _imageRestrictedModels }),
            }));
          }

          // Warn if session.reset config risks wiping ClawChats history
          if (_sessionResetWarning) {
            dc.send(JSON.stringify({
              type: 'gateway-event',
              payload: JSON.stringify({ type: 'clawchats', event: 'session-reset-warning' }),
            }));
          }

          // Persist backup code changes if any were consumed
          if (authConfig.backupCodeHashes && config!.backupCodeHashes) {
            config!.backupCodeHashes = authConfig.backupCodeHashes;
            saveConfig(config!);
          }
          return;

        case 'pending':
          // Still waiting for valid auth
          return;

        case 'blocked':
          // Pre-auth non-auth message — drop silently
          return;

        case 'pass':
          // Already authenticated — process message normally.
          // Note: if auth_timeout deleted the session but DC is still open,
          // we get 'pass' for a potentially un-authed connection. This is
          // acceptable because auth_timeout now triggers a P2P reconnect
          // (Fix 4), which re-establishes the full auth flow.
          break;
      }

      // Authenticated message processing
      processAuthenticatedMessage(dc, connectionId, msg, ctx);
    });
  } else {
    // No auth configured (schemaVersion 1 or missing TOTP)
    if (config && config.schemaVersion !== undefined && config.schemaVersion < 2) {
      ctx.logger.warn('TOTP not configured — DataChannel access blocked. Run: openclaw clawchats reauth');
      dc.send(JSON.stringify({
        type: 'auth-required-setup',
        message: 'Two-factor authentication is required. Run "openclaw clawchats reauth" on your gateway machine to set it up.',
      }));
      return; // Don't process any messages
    }

    // Legacy path: no config at all (shouldn't happen in normal flow)
    connectedClients.set(connectionId, dc);
    dc.onMessage(async (data: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data);
      } catch {
        dc.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }
      processAuthenticatedMessage(dc, connectionId, msg, ctx);
    });
  }

  dc.onClosed(() => {
    connectedClients.delete(connectionId);
    cleanupAuth(connectionId);
    app?.debugLogger.handleClientDisconnect(dc);
  });
}

/**
 * Process a message on an authenticated DataChannel.
 */
function processAuthenticatedMessage(
  dc: DataChannelLike,
  connectionId: string,
  msg: Record<string, unknown>,
  ctx: PluginServiceContext,
): void {
  switch (msg['type']) {
    case 'rpc':
      handleRpcMessage(dc, msg, ctx);
      break;

    case 'rpc-chunk-req': {
      const chunkId = msg['id'] as string;
      const index = msg['index'] as number;
      const total = msg['total'] as number;
      const chunkData = msg['data'] as string;

      if (!chunkId || typeof index !== 'number' || typeof total !== 'number' || !chunkData) {
        dc.send(JSON.stringify({ type: 'error', message: 'malformed rpc-chunk-req' }));
        break;
      }

      if (!rpcReqChunkBuffers.has(chunkId)) {
        rpcReqChunkBuffers.set(chunkId, {
          chunks: new Array(total),
          received: 0,
          total,
          createdAt: Date.now(),
        });
        setTimeout(() => rpcReqChunkBuffers.delete(chunkId), 30_000);
      }
      const rpcBuf = rpcReqChunkBuffers.get(chunkId)!;
      if (!rpcBuf.chunks[index]) {
        rpcBuf.chunks[index] = chunkData;
        rpcBuf.received++;
      }
      if (rpcBuf.received === rpcBuf.total) {
        rpcReqChunkBuffers.delete(chunkId);
        const fullMsg = rpcBuf.chunks.join('');
        try {
          const reassembled = JSON.parse(fullMsg) as Record<string, unknown>;
          handleRpcMessage(dc, reassembled, ctx);
        } catch (e) {
          dc.send(JSON.stringify({ type: 'rpc-res', id: chunkId, status: 400, body: { error: 'Failed to reassemble chunked RPC' } }));
        }
      }
      break;
    }

    case 'gateway-msg':
      if (app?.gatewayClient && typeof msg['payload'] === 'string') {
        const _gwPayload = msg['payload'] as string;
        // Persist model when sessions.patch is called
        try {
          const _gwMsg = JSON.parse(_gwPayload);
          if (_gwMsg.method === 'sessions.patch' && _gwMsg.params?.model && _gwMsg.params?.key) {
            const _db = app.getActiveDb() as any;
            _db.prepare('UPDATE threads SET model = ?, updated_at = ? WHERE session_key = ?')
              .run(_gwMsg.params.model, Date.now(), _gwMsg.params.key);
          }
        } catch { /* ignore parse/db errors */ }
        app.gatewayClient.sendToGateway(normalizeGatewayPayload(_gwPayload));
      }
      break;

    case 'gateway-msg-chunk': {
      const chunkId = msg['id'] as string;
      const index = msg['index'] as number;
      const total = msg['total'] as number;
      const chunkData = msg['data'] as string;

      if (!chunkId || typeof index !== 'number' || typeof total !== 'number' || !chunkData) {
        dc.send(JSON.stringify({ type: 'error', message: 'malformed gateway-msg-chunk' }));
        break;
      }

      if (!gatewayMsgChunkBuffers.has(chunkId)) {
        gatewayMsgChunkBuffers.set(chunkId, {
          chunks: new Array(total),
          received: 0,
          total,
          createdAt: Date.now(),
        });
        setTimeout(() => gatewayMsgChunkBuffers.delete(chunkId), 30_000);
      }
      const buf = gatewayMsgChunkBuffers.get(chunkId)!;
      if (!buf.chunks[index]) {
        buf.chunks[index] = chunkData;
        buf.received++;
      }
      if (buf.received === buf.total) {
        gatewayMsgChunkBuffers.delete(chunkId);
        const fullPayload = buf.chunks.join('');
        if (app?.gatewayClient) {
          app.gatewayClient.sendToGateway(normalizeGatewayPayload(fullPayload));
        }
      }
      break;
    }

    case 'ping':
      dc.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'clawchats':
    case 'shellchat': {
      if (!app) break;
      const action = msg['action'];
      if (action === 'debug-start') {
        const ts = typeof msg['ts'] === 'string' ? msg['ts'] : new Date().toISOString();
        const r = app.debugLogger.start(ts, dc);
        dc.send(JSON.stringify(
          r.error === 'already-active'
            ? { type: 'clawchats', event: 'debug-error', error: 'Recording already active in another tab', sessionId: r.sessionId }
            : { type: 'clawchats', event: 'debug-started', sessionId: r.sessionId }
        ));
      } else if (action === 'debug-dump') {
        const r = app.debugLogger.saveDump(msg);
        dc.send(JSON.stringify({ type: 'clawchats', event: 'debug-saved', sessionId: r.sessionId, files: r.files }));
      }
      break;
    }

    default:
      // Unknown message type — ignore silently.
      // (Sending an error response would break heartbeat backward-compat
      // on future clients that probe for new capabilities.)
      break;
  }
}

async function handleRpcMessage(
  dc: DataChannelLike,
  msg: Record<string, unknown>,
  ctx: PluginServiceContext,
): Promise<void> {
  if (!app) {
    dc.send(JSON.stringify({
      type: 'rpc-res',
      id: msg['id'],
      status: 503,
      body: { error: 'Plugin not ready' },
    }));
    return;
  }

  // API version compatibility check
  const apiVersion = msg['apiVersion'] as number | undefined;
  if (apiVersion && apiVersion > CURRENT_API_VERSION) {
    dc.send(JSON.stringify({
      type: 'rpc-res',
      id: msg['id'],
      status: 426,
      body: {
        error: 'upgrade_required',
        pluginVersion: PLUGIN_VERSION,
        message: 'Your gateway plugin needs an update.',
      },
    }));
    return;
  }

  const rpcReq: RpcRequest = {
    id: (msg['id'] as string) || '',
    method: (msg['method'] as string) || 'GET',
    url: (msg['url'] as string) || '/',
    headers: (msg['headers'] as Record<string, string>) || { 'content-type': 'application/json' },
    body: msg['body'] != null ? JSON.stringify(msg['body']) : undefined,
  };

  try {
    const response = await dispatchRpc(rpcReq, app.handleRequest as (req: unknown, res: unknown) => void | Promise<void>);

    // For binary content types (images, audio, etc.), wrap as _binary envelope
    // so the browser transport can reconstruct a proper Blob with correct MIME type
    const contentType = response.headers['content-type'] || '';
    const isBinaryResponse = /^(image|audio|video|application\/octet-stream|application\/pdf)/.test(contentType);

    let responseBody: unknown;
    if (isBinaryResponse && response.rawBody) {
      // Encode raw bytes as base64 in a _binary envelope.
      // The transport layer on the browser side already handles this format,
      // reconstructing a proper Blob with the correct MIME type.
      responseBody = {
        _binary: true,
        contentType,
        data: response.rawBody.toString('base64'),
      };
    } else {
      responseBody = response.body;
    }

    const responseMsg = {
      type: 'rpc-res',
      id: response.id,
      status: response.status,
      body: responseBody,
    };

    const responseStr = JSON.stringify(responseMsg);
    if (responseStr.length > MAX_DC_MESSAGE_SIZE) {
      sendChunked(dc, response.id, response.status, JSON.stringify(responseBody));
    } else {
      dc.send(responseStr);
    }
  } catch (e) {
    ctx.logger.error(`RPC error: ${(e as Error).message}`);
    dc.send(JSON.stringify({
      type: 'rpc-res',
      id: msg['id'],
      status: 500,
      body: { error: 'Internal plugin error' },
    }));
  }
}

function sendChunked(dc: DataChannelLike, id: string, status: number, body: string): void {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const chunkSize = 128 * 1024; // 128KB — safe margin for JSON envelope + escaping overhead
  const totalChunks = Math.ceil(data.length / chunkSize);

  for (let i = 0; i < totalChunks; i++) {
    dc.send(JSON.stringify({
      type: 'rpc-chunk',
      id,
      status,
      index: i,
      total: totalChunks,
      data: data.slice(i * chunkSize, (i + 1) * chunkSize),
    }));
  }
}

// ---------------------------------------------------------------------------
// Broadcast helper
// ---------------------------------------------------------------------------

function broadcastToClients(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const [id, client] of connectedClients) {
    try {
      client.send(data);
    } catch {
      connectedClients.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Status helper
// ---------------------------------------------------------------------------

function formatStatus(): string {
  const lines: string[] = [];
  lines.push(`ClawChats Plugin v${PLUGIN_VERSION}`);
  lines.push(`Gateway: ${app?.gatewayClient?.connected ? 'connected' : 'disconnected'}`);
  lines.push(`Signaling: ${signaling?.isConnected ? 'connected' : 'disconnected'}`);
  lines.push(`Clients: ${connectedClients.size}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI handlers
// ---------------------------------------------------------------------------

async function handleSetup(token: string, options: { skipTotp?: boolean } = {}): Promise<void> {
  // Decode base64 token
  let tokenData: { serverUrl: string; setupSecret: string; expiresAt: string };
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    tokenData = JSON.parse(decoded);
  } catch {
    console.error('Invalid setup token. Check that you copied it correctly.');
    return;
  }

  if (new Date(tokenData.expiresAt) < new Date()) {
    console.error('Setup token has expired. Generate a new one from clawchats.ai.');
    return;
  }

  console.log('Setting up ClawChats...');
  console.log(`  Server: ${tokenData.serverUrl}`);

  // Generate API key for signaling server auth
  const { randomBytes } = await import('node:crypto');
  const apiKey = randomBytes(32).toString('hex');

  // Read gateway token from OpenClaw config
  let gatewayToken = '';
  try {
    const openclawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
    gatewayToken = openclawConfig.gateway?.auth?.token || openclawConfig.auth?.token || openclawConfig.token || '';
  } catch {
    console.error('Could not read gateway token from ~/.openclaw/openclaw.json');
    console.error('Make sure OpenClaw is installed and configured.');
    return;
  }

  if (!gatewayToken) {
    console.error('No gateway token found in ~/.openclaw/openclaw.json');
    return;
  }

  // Connect to signaling server to complete setup
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(tokenData.serverUrl);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Setup timed out'));
    }, 30_000);

    ws.on('open', () => {
      const setupHostname = os.hostname();
      ws.send(JSON.stringify({
        type: 'setup',
        setupSecret: tokenData.setupSecret,
        apiKey,
        hostname: setupHostname,
      }));
    });

    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'setup-complete') {
        clearTimeout(timeout);
        console.log(`  User: ${msg.email || msg.userId}`);
        console.log('  Registering gateway... ✅');

        // Save initial config (schemaVersion 1 — will upgrade to 2 after TOTP enrollment)
        const config: PluginConfig = {
          userId: msg.userId,
          serverUrl: tokenData.serverUrl,
          apiKey,
          gatewayId: msg.gatewayId,
          gatewayToken,
          schemaVersion: 1,
          installedAt: new Date().toISOString(),
        };

        // Bind Google identity if provided by signaling server
        if (msg.google) {
          config.google = {
            clientId: msg.google.clientId,
            authorizedSub: msg.google.sub,
            authorizedEmail: msg.google.email,
          };
        }

        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        saveConfig(config);

        // Create data directories
        const dataDir = path.join(CONFIG_DIR, 'data');
        const uploadsDir = path.join(CONFIG_DIR, 'uploads');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(uploadsDir, { recursive: true });

        ws.close();

        if (options.skipTotp) {
          // Agent-driven flow: skip interactive TOTP enrollment.
          // User will run setup-totp + verify-totp separately.
          console.log('');
          console.log('  ✅ Setup complete!');
          console.log('');
          console.log('  2FA setup pending. Run these commands to enable it:');
          console.log('    openclaw clawchats setup-totp');
          console.log('    openclaw clawchats verify-totp <6-digit-code>');
          console.log('');
          console.log('  Then restart:  openclaw gateway restart');
          console.log('');
        } else {
          // Interactive (human) flow: enroll TOTP now.
          const totpOk = await enrollTotp(config);
          if (!totpOk) {
            console.log('');
            console.log('  ⚠️  TOTP not configured. You can set it up later with: openclaw clawchats reauth');
            console.log('  ClawChats will not allow browser connections until 2FA is enabled.');
          }

          console.log('  ✅ Setup complete!');
          console.log('');
          console.log('  Next steps:');
          console.log('  1. Restart your gateway:   openclaw gateway restart');
          console.log('     (or: systemctl --user restart openclaw-gateway)');
          console.log('  2. Open ClawChats:         https://app.clawchats.ai');
          console.log('');
          console.log('  The gateway will connect automatically after restart.');
        }
        resolve();
      } else if (msg.type === 'setup-error') {
        clearTimeout(timeout);
        ws.close();
        const reasons: Record<string, string> = {
          'invalid_or_expired_token': 'Setup token is invalid or has expired. Generate a new one at clawchats.ai.',
          'missing_fields': 'Setup failed: malformed token. Try copying the command again.',
        };
        const message = reasons[msg.reason] ?? `Setup failed: ${msg.reason}. Try again or visit clawchats.ai for support.`;
        reject(new Error(message));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function enrollTotp(config: PluginConfig): Promise<boolean> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  try {
    // Ask once if the user wants to reuse a TOTP secret from another gateway
    console.log('');
    console.log('  💡 Already have ClawChats on another gateway?');
    console.log('     Run `openclaw clawchats show-totp` on that machine, then paste the secret below.');
    const reuseAnswer = await ask('  Paste existing TOTP secret (or press Enter to set up new): ');
    const existingSecret = reuseAnswer.trim() || undefined;

    let totpSecret: string;

    if (existingSecret) {
      // Reusing secret from another gateway — strip spaces, uppercase
      totpSecret = existingSecret.replace(/\s+/g, '').toUpperCase();
      console.log('');
      console.log('  🔐 Verifying existing TOTP secret…');
      console.log('');
    } else {
      // Generate a brand new TOTP secret
      totpSecret = generateTotpSecret();
      const email = config.google?.authorizedEmail || config.userId;
      void buildOtpauthUri(totpSecret, email); // keep import used
      const formatted = totpSecret.match(/.{1,4}/g)?.join(' ') || totpSecret;

      console.log('');
      console.log('  🔐 Setting up two-factor authentication');
      console.log('');
      console.log('  Open this link to scan the QR code with your authenticator app:');
      console.log(`  ${config.serverUrl.replace('wss://', 'https://').replace(/\/ws\/?$/, '')}/totp-setup#${totpSecret}`);
      console.log('');
      console.log(`  Or enter this code manually: ${formatted}`);
      console.log('');
      console.log("  Don't have an authenticator app?");
      console.log('  Google Authenticator: https://apps.apple.com/app/google-authenticator/id388497605');
      console.log('                        https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2');
      console.log('');
    }

    // Verification loop
    let verified = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = await ask('  Enter a code from your app to verify: ');
      const step = verifyTotp(code.trim(), totpSecret, 0);
      if (step >= 0) {
        verified = true;
        break;
      }
      console.log('  ❌ Invalid code. Make sure you scanned the right QR code and try again.');
    }

    if (!verified) {
      console.log('  Too many failed attempts. TOTP setup cancelled.');
      rl.close();
      return false;
    }

    console.log('  ✅ Two-factor authentication enabled!');

    // Generate backup codes
    const { codes, hashes } = generateBackupCodes();
    console.log('');
    console.log('  🔑 Backup codes (save these somewhere safe — one-time use):');
    for (const code of codes) {
      console.log(`     ${code}`);
    }
    console.log('');
    console.log('  ⚠️  These codes will NOT be shown again.');

    // Generate session secret
    const sessionSecret = generateSessionSecret();

    // Update config
    config.totp = {
      secret: totpSecret,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      enabledAt: new Date().toISOString(),
    };
    config.sessionSecret = sessionSecret;
    config.backupCodeHashes = hashes;
    config.schemaVersion = 2;

    saveConfig(config);
    console.log('');

    rl.close();
    return true;
  } catch (e) {
    rl.close();
    console.error(`  TOTP setup failed: ${(e as Error).message}`);
    return false;
  }
}

async function handleShowTotp(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('ClawChats not configured. Run: openclaw clawchats setup <token>');
    return;
  }
  if (!config.totp?.secret) {
    console.error('No TOTP secret found. Run: openclaw clawchats reauth to set one up first.');
    return;
  }
  console.log('');
  console.log('Your TOTP secret (account-level, keep this safe):');
  console.log('');
  console.log(`  ${config.totp.secret}`);
  console.log('');
  console.log('To reuse this on a new gateway:');
  console.log('  1. Generate a setup token at login.clawchats.ai/dashboard');
  console.log('  2. On the new machine: openclaw clawchats setup <token>');
  console.log('  3. When prompted for a TOTP secret, paste the value above');
  console.log('');
}

// ---------------------------------------------------------------------------
// Agent-driven TOTP setup (setup-totp + verify-totp)
// ---------------------------------------------------------------------------

async function handleSetupTotp(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('ClawChats not configured. Run: openclaw clawchats setup <token> --skip-totp');
    return;
  }
  if (config.schemaVersion >= 2 && config.totp) {
    console.error('TOTP already active. Use: openclaw clawchats reauth to reset.');
    return;
  }

  // Idempotency: reuse pending secret if generated within the last 24 hours.
  // Prevents stale-secret issues when the agent retries or the user reruns the command.
  const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
  let totpSecret: string;
  const existing = config.totpPending;
  if (existing?.secret && existing.generatedAt) {
    const age = Date.now() - new Date(existing.generatedAt).getTime();
    if (age < PENDING_TTL_MS) {
      totpSecret = existing.secret;
    } else {
      // Expired — generate a fresh one
      totpSecret = process.env.CLAWCHATS_DEV_TOTP_SECRET || generateTotpSecret();
      config.totpPending = { secret: totpSecret, generatedAt: new Date().toISOString() };
      saveConfig(config);
    }
  } else {
    totpSecret = process.env.CLAWCHATS_DEV_TOTP_SECRET || generateTotpSecret();
    config.totpPending = { secret: totpSecret, generatedAt: new Date().toISOString() };
    saveConfig(config);
  }

  const formatted = totpSecret.match(/.{1,4}/g)?.join(' ') || totpSecret;
  const setupUrl = `${config.serverUrl.replace('wss://', 'https://').replace(/\/ws\/?$/, '')}/totp-setup#${totpSecret}`;

  console.log('');
  console.log('  🔐 ClawChats Two-Factor Authentication Setup');
  console.log('');
  console.log('  Open this URL to scan the QR code with your authenticator app:');
  console.log(`  ${setupUrl}`);
  console.log('');
  console.log(`  Or enter manually: ${formatted}`);
  console.log('');
  console.log('  Once added, verify with:');
  console.log('    openclaw clawchats verify-totp <6-digit-code>');
  console.log('');
}

async function handleVerifyTotp(code: string): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('ClawChats not configured. Run: openclaw clawchats setup <token> --skip-totp');
    return;
  }
  if (config.schemaVersion >= 2 && config.totp) {
    console.error('TOTP already active. Use: openclaw clawchats reauth to reset.');
    return;
  }
  if (!config.totpPending?.secret) {
    console.error('No pending TOTP secret. Run: openclaw clawchats setup-totp first.');
    return;
  }

  const step = verifyTotp(code.trim(), config.totpPending.secret, 0);
  if (step < 0) {
    console.error('  ❌ Invalid code. Make sure you scanned the correct QR code and try again.');
    console.error('     Run: openclaw clawchats verify-totp <new-code>');
    process.exit(1);
  }

  // Generate backup codes
  const { codes, hashes } = generateBackupCodes();
  console.log('');
  console.log('  🔑 Backup codes (save these somewhere safe — one-time use):');
  for (const backupCode of codes) {
    console.log(`     ${backupCode}`);
  }
  console.log('');
  console.log('  ⚠️  These codes will NOT be shown again.');

  // Generate session secret and finalize config
  const sessionSecret = generateSessionSecret();
  config.totp = {
    secret: config.totpPending.secret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    enabledAt: new Date().toISOString(),
  };
  config.sessionSecret = sessionSecret;
  config.backupCodeHashes = hashes;
  config.schemaVersion = 2;
  delete config.totpPending;
  saveConfig(config);

  console.log('');
  console.log('  ✅ Two-factor authentication enabled!');
  console.log('');
  console.log('  Restart the gateway to apply:');
  console.log('    openclaw gateway restart');
  console.log('');
}

async function handleReauth(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('ClawChats not configured. Run: openclaw clawchats setup <token>');
    return;
  }

  console.log('🔐 Re-initializing ClawChats authentication...');
  console.log('');
  console.log('  ⚠️  This will invalidate all existing sessions.');
  console.log('  All connected browsers will need to re-authenticate.');
  console.log('');

  const success = await enrollTotp(config);
  if (success) {
    console.log('  All previous sessions have been invalidated.');
    console.log('  Restart the gateway for changes to take effect: systemctl --user restart openclaw-gateway');
  }
}

async function handleStatus(): Promise<void> {
  // CLI runs in a separate process — module-level vars are null here.
  // Query the live service via the health endpoint instead.
  let runtime: { pid: number; healthPort: number; startedAt: string };
  try {
    runtime = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  } catch {
    console.log('ClawChats: offline (service not running)');
    return;
  }

  // Verify PID is alive
  try {
    process.kill(runtime.pid, 0);
  } catch {
    console.log('ClawChats: offline (stale runtime file)');
    try { fs.unlinkSync(RUNTIME_FILE); } catch { /* ignore */ }
    return;
  }

  // Query health endpoint
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${runtime.healthPort}/status`, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    const status = JSON.parse(body) as {
      version: string;
      uptime: number;
      gateway: { connected: boolean };
      signaling: { connected: boolean };
      clients: { active: number };
    };

    console.log(`ClawChats Plugin v${status.version}`);
    console.log(`Uptime: ${Math.floor(status.uptime)}s`);
    console.log(`Gateway: ${status.gateway.connected ? 'connected' : 'disconnected'}`);
    console.log(`Signaling: ${status.signaling.connected ? 'connected' : 'disconnected'}`);
    console.log(`Clients: ${status.clients.active}`);
  } catch {
    console.log('ClawChats: offline (could not reach service)');
  }
}

async function handleReset(): Promise<void> {
  try {
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
    console.log('ClawChats data removed. Plugin disconnected.');
  } catch (e) {
    console.error(`Reset failed: ${(e as Error).message}`);
  }
}

async function handleImport(sourcePath: string): Promise<void> {
  const resolvedSource = path.resolve(sourcePath);

  if (!fs.existsSync(resolvedSource)) {
    console.error(`Source path not found: ${resolvedSource}`);
    return;
  }

  const stat = fs.statSync(resolvedSource);
  if (!stat.isDirectory()) {
    console.error(`Source must be a directory: ${resolvedSource}`);
    return;
  }

  // Destination: ~/.openclaw/clawchats/data/
  const destDataDir = path.join(CONFIG_DIR, 'data');
  fs.mkdirSync(destDataDir, { recursive: true });

  // Import .db files
  const dbFiles = fs.readdirSync(resolvedSource).filter(f => f.endsWith('.db'));

  if (dbFiles.length === 0) {
    console.log('No .db files found in source directory.');
  } else {
    console.log(`Importing ${dbFiles.length} database(s) from ${resolvedSource}...`);
    let imported = 0;
    let skipped = 0;

    for (const file of dbFiles) {
      const src = path.join(resolvedSource, file);
      const dst = path.join(destDataDir, file);

      fs.copyFileSync(src, dst);
      console.log(`  ✓ ${file}`);
      imported++;
    }

    console.log(`Databases: ${imported} imported.`);
  }

  // Import .json config files (workspaces.json, settings.json, etc.)
  const jsonFiles = fs.readdirSync(resolvedSource).filter(f => f.endsWith('.json'));

  if (jsonFiles.length > 0) {
    for (const file of jsonFiles) {
      const src = path.join(resolvedSource, file);
      const dst = path.join(destDataDir, file);
      fs.copyFileSync(src, dst);
      console.log(`  ✓ ${file}`);
    }
  }

  // Also try to migrate config.json from the parent directory
  // e.g. if source is ~/.openclaw/clawchats/data/, config is at ~/.openclaw/clawchats/config.json
  const parentConfigPath = path.join(path.dirname(resolvedSource), 'config.json');
  if (fs.existsSync(parentConfigPath)) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.copyFileSync(parentConfigPath, CONFIG_FILE);
      console.log('  ✓ config.json (plugin credentials migrated)');
    } catch (e) {
      console.error(`  Failed to migrate config.json: ${(e as Error).message}`);
    }
  }

  console.log('Done.');
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: OpenClawPluginDefinition = {
  id: PLUGIN_ID,
  name: 'ClawChats',
  description: 'Connects your gateway to ClawChats via WebRTC P2P',

  register(api: PluginApi) {
    // Inject MEDIA: capability note into the system prompt via before_prompt_build.
    // Appended to system context (trusted, not user-turn) so it's always present and
    // never flagged as prompt injection. Survives compaction automatically.
    //
    // Path parsing lives in server/gateway.js handleAgentEvent (stable singleton) —
    // do NOT hold state in this closure; OpenClaw may call register() multiple times
    // during the plugin lifecycle and each call creates a fresh closure.
    api.on('before_prompt_build', (_event, _ctx) => {
      return {
        appendSystemContext: 'ClawChats inline preview: after writing a file with the Write tool, run `echo "MEDIA:/absolute/path/to/file"` via the exec tool to display it inline in the chat UI.',
      };
    }, { name: 'clawchats-media-hint', description: 'Appends MEDIA: file preview capability note to system prompt' });

    // Background service: signaling + gateway bridge + future WebRTC
    api.registerService({
      id: 'connector-service',
      start: (ctx) => startClawChats(ctx, api),
      stop: (ctx) => stopClawChats(ctx),
    });

    // CLI commands
    api.registerCli((ctx) => {
      const cmd = ctx.program.command('clawchats');

      cmd.command('setup <token>')
        .description('Set up ClawChats with a setup token (interactive — prompts for TOTP)')
        .action((token: unknown) => handleSetup(String(token), {}));

      cmd.command('setup-agent <token>')
        .description('Set up ClawChats non-interactively for agent-driven installs (skips TOTP — run setup-totp + verify-totp separately)')
        .action((token: unknown) => handleSetup(String(token), { skipTotp: true }));

      cmd.command('status')
        .description('Show ClawChats connection status')
        .action(() => handleStatus());

      cmd.command('setup-totp')
        .description('Generate TOTP QR code for agent-driven 2FA setup (run after setup --skip-totp)')
        .action(() => handleSetupTotp());

      cmd.command('verify-totp <code>')
        .description('Verify TOTP code and finalize 2FA setup (agent-driven flow)')
        .action((code: unknown) => handleVerifyTotp(String(code)));

      cmd.command('reauth')
        .description('Reset two-factor authentication (new TOTP secret + invalidate sessions)')
        .action(() => handleReauth());

      cmd.command('show-totp')
        .description('Show your TOTP secret (use when adding ClawChats to a second gateway)')
        .action(() => handleShowTotp());

      cmd.command('reset')
        .description('Disconnect and remove all ClawChats data')
        .action(() => handleReset());

      cmd.command('import <path>')
        .description('Import databases and config from a folder (e.g. migrate from old data directory)')
        .action((srcPath: unknown) => handleImport(String(srcPath)));
    }, { commands: ['clawchats'] });

    // Slash command for status from any channel
    api.registerCommand({
      name: 'clawchats',
      description: 'Show ClawChats tunnel status',
      handler: () => ({ text: formatStatus() }),
    });
  },
};

export default plugin;
