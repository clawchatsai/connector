/**
 * SignalingClient — persistent WSS connection to the ClawChats signaling server.
 *
 * Responsibilities:
 * - Authenticate with the signaling server on connect (gateway-auth)
 * - Relay ICE offers/answers for WebRTC negotiation
 * - Report active DataChannel connection count
 * - Handle server push messages (force-update, account-suspended, device-limit-updated)
 * - Reconnect with exponential backoff on unintentional disconnects
 *
 * Per spec: signaling server sends WS pings every 30s; the `ws` library
 * handles pong automatically. If no ping is received for 90s (3 missed),
 * the connection is considered dead and we reconnect.
 */

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { PLUGIN_VERSION } from './index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IceOffer {
  connectionId: string;
  sdp: string;
  candidates: unknown[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Backoff delays in ms: 1s, 2s, 4s, 8s, 16s, capped at 30s */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * How long to wait without receiving a WS ping before declaring the
 * connection dead. Signaling server pings every 30s; three missed = 90s.
 */
const PING_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// SignalingClient
// ---------------------------------------------------------------------------

export class SignalingClient extends EventEmitter {
  private readonly serverUrl: string;
  private readonly userId: string;
  private readonly apiKey: string;
  private readonly gatewayId?: string;
  private readonly hostname?: string;

  private ws: WebSocket | null = null;

  /** True only after gateway-auth-ok has been received. */
  private _connected = false;

  /**
   * Set to true by disconnect() or after an auth rejection.
   * Prevents reconnect loops when the close is intentional.
   */
  private intentionalClose = false;

  /** Number of consecutive reconnect attempts (resets on successful auth). */
  private reconnectAttempts = 0;

  /** Timer handle for the scheduled reconnect. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Timer handle for ping-timeout watchdog. */
  private pingWatchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(serverUrl: string, userId: string, apiKey: string, opts?: { gatewayId?: string; hostname?: string }) {
    super();
    this.serverUrl = serverUrl;
    this.userId = userId;
    this.apiKey = apiKey;
    this.gatewayId = opts?.gatewayId;
    this.hostname = opts?.hostname;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Returns true when gateway-auth-ok has been received on the current socket. */
  get isConnected(): boolean {
    return this._connected;
  }

  /**
   * Open the WebSocket connection and perform the gateway-auth handshake.
   * Resolves once the socket is open (not necessarily authenticated yet).
   * Authentication outcome is signalled via 'connected' / 'auth-rejected' events.
   */
  connect(): Promise<void> {
    this.intentionalClose = false;
    return this._openSocket();
  }

  /**
   * Intentionally close the connection. Suppresses reconnection.
   */
  disconnect(): void {
    this.intentionalClose = true;
    this._clearReconnectTimer();
    this._clearPingWatchdog();
    this._connected = false;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Send a connection-count report to the signaling server.
   * Call whenever a DataChannel opens or closes.
   */
  reportConnectionCount(active: number): void {
    this._send({ type: 'connection-count', active });
  }

  /**
   * Send an ICE answer back to the signaling server in response to an
   * ice-offer that was forwarded to us by the server.
   */
  sendIceAnswer(connectionId: string, sdp: string, candidates: unknown[]): void {
    this._send({ type: 'ice-answer', connectionId, sdp, candidates });
  }

  /**
   * Send a trickle ICE candidate from the plugin to a browser via signaling.
   */
  sendIceCandidate(connectionId: string, candidate: unknown): void {
    this._send({ type: 'ice-candidate', connectionId, candidate });
  }

  // -------------------------------------------------------------------------
  // Internal — socket lifecycle
  // -------------------------------------------------------------------------

  private _openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Guard: never open two sockets simultaneously
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.close();
        this.ws = null;
      }

      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      const socket = new WebSocket(this.serverUrl);
      this.ws = socket;

      socket.on('open', () => {
        // Send gateway-auth as the first message
        this._send({
          type: 'gateway-auth',
          userId: this.userId,
          apiKey: this.apiKey,
          pluginVersion: PLUGIN_VERSION,
          ...(this.gatewayId ? { gatewayId: this.gatewayId } : {}),
          ...(this.hostname ? { hostname: this.hostname } : {}),
        });

        // Resolve the connect() promise: the socket is open and auth is in flight
        settle();
      });

      socket.on('ping', () => {
        // ws library handles sending the pong automatically.
        // We just need to reset our watchdog timer.
        this._resetPingWatchdog();
      });

      socket.on('message', (raw: Buffer | string) => {
        this._handleMessage(raw);
      });

      socket.on('error', (err: Error) => {
        // Reject connect() if we haven't resolved yet; otherwise log only
        if (!settled) {
          settle(err);
        }
        // The 'close' event will fire after 'error', so reconnection is
        // handled there — no duplicate reconnect scheduling needed here.
      });

      socket.on('close', (_code: number, _reason: Buffer) => {
        this._connected = false;
        this._clearPingWatchdog();
        this.ws = null;

        this.emit('disconnected');

        if (!settled) {
          // connect() is still pending — reject it
          settle(new Error('WebSocket closed before open'));
          return;
        }

        if (!this.intentionalClose) {
          this._scheduleReconnect();
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Internal — message handling
  // -------------------------------------------------------------------------

  private _handleMessage(raw: Buffer | string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      console.error('[SignalingClient] Received non-JSON message, ignoring');
      return;
    }

    const type = msg['type'] as string | undefined;

    switch (type) {
      case 'gateway-auth-ok': {
        this._connected = true;
        this.reconnectAttempts = 0;
        this._resetPingWatchdog();
        this.emit('connected');
        break;
      }

      case 'gateway-auth-rejected': {
        const reason = (msg['reason'] as string) ?? 'unknown';
        console.error(`[SignalingClient] Auth rejected: ${reason}`);
        // Do not reconnect after auth rejection — the API key is invalid
        this.intentionalClose = true;
        this.emit('auth-rejected', reason);
        break;
      }

      // version-rejected removed — version compatibility is now checked
      // client-side via pluginVersion in connect-ready

      case 'ice-offer': {
        const offer: IceOffer = {
          connectionId: (msg['connectionId'] as string) ?? '',
          sdp: (msg['sdp'] as string) ?? '',
          candidates: (msg['candidates'] as unknown[]) ?? [],
        };
        this.emit('ice-offer', offer);
        break;
      }

      case 'ice-servers': {
        // ICE server config (STUN/TURN) arrives before the offer for a connection.
        const connectionId = (msg['connectionId'] as string) ?? '';
        const iceServers = (msg['iceServers'] as Array<{ urls: string; username?: string; credential?: string }>) ?? [];
        this.emit('ice-servers', { connectionId, iceServers });
        break;
      }

      case 'ice-candidate': {
        // Trickle ICE candidate from browser, relayed by signaling server.
        const connectionId = (msg['connectionId'] as string) ?? '';
        const candidate = msg['candidate'] ?? null;
        this.emit('ice-candidate', { connectionId, candidate });
        break;
      }

      case 'force-update': {
        const targetVersion = (msg['targetVersion'] as string) ?? '';
        const reason = (msg['reason'] as string) ?? '';
        this.emit('force-update', targetVersion, reason);
        break;
      }

      case 'account-suspended': {
        const reason = (msg['reason'] as string) ?? '';
        // Stop reconnecting — account is suspended
        this.intentionalClose = true;
        this.emit('account-suspended', reason);
        break;
      }

      case 'device-limit-updated': {
        const deviceLimit = (msg['deviceLimit'] as number) ?? 0;
        this.emit('device-limit-updated', deviceLimit);
        break;
      }

      default: {
        // Unknown messages are silently ignored to allow forward compatibility
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal — send helper
  // -------------------------------------------------------------------------

  private _send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[SignalingClient] Send error:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Internal — reconnection
  // -------------------------------------------------------------------------

  private _scheduleReconnect(): void {
    if (this.intentionalClose) return;

    // Exponential backoff: 1s * 2^attempt, capped at BACKOFF_MAX_MS
    const delay = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts),
      BACKOFF_MAX_MS,
    );
    this.reconnectAttempts++;

    console.log(
      `[SignalingClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose) return;

      this._openSocket().catch((err) => {
        console.error('[SignalingClient] Reconnect failed:', err);
        // The 'close' event will have already scheduled the next attempt
      });
    }, delay);
  }

  private _clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal — ping watchdog
  // -------------------------------------------------------------------------

  /**
   * Restart the 90-second watchdog timer. Called on gateway-auth-ok and on
   * every received ping frame. If the timer fires, the connection is dead
   * and we force a reconnect.
   */
  private _resetPingWatchdog(): void {
    this._clearPingWatchdog();

    this.pingWatchdog = setTimeout(() => {
      console.warn(
        '[SignalingClient] No ping received for 90s — connection presumed dead, reconnecting',
      );
      // Force-close the socket; the 'close' handler will schedule reconnect
      if (this.ws) {
        this.ws.terminate();
        this.ws = null;
      }
    }, PING_TIMEOUT_MS);
  }

  private _clearPingWatchdog(): void {
    if (this.pingWatchdog !== null) {
      clearTimeout(this.pingWatchdog);
      this.pingWatchdog = null;
    }
  }
}
