/**
 * GatewayBridge — persistent WebSocket connection to the local OpenClaw gateway.
 *
 * Responsibilities:
 * 1. Connect to the local gateway using token-only auth (loopback connections
 *    with valid token skip device identity entirely).
 * 2. Broadcast incoming gateway events to all connected DataChannel clients
 *    via the 'gateway-event' EventEmitter event.
 * 3. Reconnect with exponential backoff on disconnect.
 */

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { PLUGIN_VERSION } from './index.js';

export interface PluginConfig {
  userId: string;
  serverUrl: string;
  apiKey: string;
  gatewayId?: string;
  gatewayToken?: string;
  devicePrivateKey?: string; // deprecated, kept for backward compat with existing config files
  schemaVersion: number;
  installedAt: string;
  // 2FA fields (schemaVersion 2)
  totp?: {
    secret: string;
    algorithm: string;
    digits: number;
    period: number;
    enabledAt: string;
  };
  google?: {
    clientId: string;
    authorizedSub: string;
    authorizedEmail: string;
  };
  sessionSecret?: string;
  backupCodeHashes?: string[];
}

export interface BridgeConfig {
  gatewayToken: string;
  dataDir: string;
}

// Reconnect backoff constants (milliseconds)
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// Fixed client identity fields
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const ROLE = 'operator';
const SCOPES = ['operator.read', 'operator.write', 'operator.admin'];

// ---------------------------------------------------------------------------
// Device Identity — ed25519 key generation + connect payload signing
// Required by OpenClaw ≥2.15 to prevent scope clearing on connect.
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

interface DeviceIdentity {
  version: number;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

function _derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function _fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(_derivePublicKeyRaw(publicKeyPem)).digest('hex');
}

function _base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function _loadOrCreateDeviceIdentity(identityPath: string): DeviceIdentity {
  try {
    if (fs.existsSync(identityPath)) {
      const parsed = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
      if (parsed?.version === 1 && parsed.deviceId && parsed.publicKeyPem && parsed.privateKeyPem) {
        return parsed;
      }
    }
  } catch { /* regenerate */ }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const identity: DeviceIdentity = {
    version: 1,
    deviceId: _fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now(),
  };
  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  return identity;
}

function _buildDeviceAuth(
  identity: DeviceIdentity,
  params: { clientId: string; clientMode: string; role: string; scopes: string[]; token: string; nonce: string },
): Record<string, unknown> {
  const signedAt = Date.now();
  const payload = [
    'v2', identity.deviceId, params.clientId, params.clientMode,
    params.role, params.scopes.join(','), String(signedAt),
    params.token || '', params.nonce,
  ].join('|');
  const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
  const signature = _base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey));
  const publicKeyB64Url = _base64UrlEncode(_derivePublicKeyRaw(identity.publicKeyPem));
  return { id: identity.deviceId, publicKey: publicKeyB64Url, signature, signedAt, nonce: params.nonce };
}

// ---------------------------------------------------------------------------

export class GatewayBridge extends EventEmitter {
  private readonly gatewayUrl: string;
  private readonly config: BridgeConfig;

  private ws: WebSocket | null = null;
  private _isConnected: boolean = false;
  private destroyed: boolean = false;

  // Reconnect state
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number = BACKOFF_INITIAL_MS;

  constructor(gatewayUrl: string, config: BridgeConfig) {
    super();
    this.gatewayUrl = gatewayUrl;
    this.config = config;
  }

  /**
   * Initiate the connection. Resolves once the WebSocket has been opened
   * (not necessarily after the gateway handshake completes — listen for
   * the 'connected' event for that).
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('GatewayBridge has been destroyed'));
        return;
      }

      this._openSocket(resolve, reject);
    });
  }

  /**
   * Forward a message to the gateway (transparent proxy).
   */
  send(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[GatewayBridge] send() called but WebSocket is not open');
      return;
    }
    this.ws.send(data);
  }

  /**
   * Permanently close the connection and cancel any pending reconnect.
   */
  disconnect(): void {
    this.destroyed = true;
    this._cancelReconnect();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    this._isConnected = false;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _openSocket(
    resolveConnect: (() => void) | null = null,
    rejectConnect: ((err: Error) => void) | null = null,
  ): void {
    console.log(`[GatewayBridge] Connecting to ${this.gatewayUrl}`);

    const ws = new WebSocket(this.gatewayUrl);
    this.ws = ws;

    let resolved = false;

    ws.on('open', () => {
      console.log('[GatewayBridge] WebSocket opened');
      if (!resolved && resolveConnect) {
        resolved = true;
        resolveConnect();
      }
    });

    ws.on('error', (err: Error) => {
      console.error('[GatewayBridge] WebSocket error:', err.message);
      if (!resolved && rejectConnect) {
        resolved = true;
        rejectConnect(err);
      }
    });

    ws.on('message', (raw: Buffer | string) => {
      this._handleMessage(typeof raw === 'string' ? raw : raw.toString('utf8'));
    });

    ws.on('close', (code: number, reason: Buffer) => {
      console.log(
        `[GatewayBridge] WebSocket closed (code=${code} reason=${reason.toString('utf8') || '(none)'})`,
      );
      this._isConnected = false;
      this.ws = null;
      this.emit('disconnected');

      if (!this.destroyed) {
        this._scheduleReconnect();
      }
    });
  }

  private _handleMessage(raw: string): void {
    // Always broadcast the raw event to connected DataChannel clients first.
    this.emit('gateway-event', raw);

    // Parse for handshake handling.
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Non-JSON frame — forward as-is, ignore for handshake purposes.
      return;
    }

    const type = msg['type'] as string | undefined;
    const event = msg['event'] as string | undefined;

    // connect.challenge → send signed connect request with device identity
    if (type === 'event' && event === 'connect.challenge') {
      const payload = msg['payload'] as Record<string, unknown> | undefined;
      const nonce = (payload?.['nonce'] as string) ?? '';
      this._sendConnect(nonce);
      return;
    }

    // hello-ok → handshake complete
    if (type === 'res') {
      const payload = msg['payload'] as Record<string, unknown> | undefined;
      if (payload?.['type'] === 'hello-ok') {
        console.log('[GatewayBridge] Gateway handshake complete');
        this._isConnected = true;
        // Reset backoff on successful connection.
        this.backoffMs = BACKOFF_INITIAL_MS;
        this.emit('connected');
      }
    }
  }

  private _sendConnect(nonce: string): void {
    const identityPath = path.join(this.config.dataDir, 'device-identity.json');
    const identity = _loadOrCreateDeviceIdentity(identityPath);
    const device = _buildDeviceAuth(identity, {
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: ROLE,
      scopes: SCOPES,
      token: this.config.gatewayToken,
      nonce,
    });

    this.send(JSON.stringify({
      type: 'req',
      id: 'gw-connect-1',
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: CLIENT_ID,
          version: PLUGIN_VERSION,
          platform: 'node',
          mode: CLIENT_MODE,
        },
        role: ROLE,
        scopes: SCOPES,
        device,
        auth: { token: this.config.gatewayToken },
        caps: ['tool-events'],
      },
    }));
  }

  private _scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer !== null) return; // already scheduled

    console.log(`[GatewayBridge] Reconnecting in ${this.backoffMs}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) {
        this._openSocket();
      }
    }, this.backoffMs);

    // Exponential backoff: double each time, cap at BACKOFF_MAX_MS.
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private _cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
