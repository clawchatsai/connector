import path from 'node:path';
import { WebSocket as WS } from 'ws';
import { loadOrCreateDeviceIdentity, buildDeviceAuth } from './bootstrap/identity.js';

// Per-session run/transcript events; hidden sessions' ones are dropped by the lens.
const RUN_EVENTS = new Set(['chat', 'agent', 'session.tool', 'session.operation', 'session.observer']);

export class GatewayClient {
  constructor({ dataDir, debugLogger, gatewayWsUrl, authToken }) {
    this.dataDir = dataDir;
    this.debugLogger = debugLogger;
    this.gatewayWsUrl = gatewayWsUrl;
    this.authToken = authToken;
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.browserClients = new Map();
    this._externalBroadcastTargets = [];
    this._rpc = new Map(); // request id → { resolve, reject, timer } for connector-originated RPCs
    this._rpcSeq = 0;
  }

  connect() {
    if (this._closed) return;
    if (this.ws && (this.ws.readyState === WS.CONNECTING || this.ws.readyState === WS.OPEN)) return;
    console.log(`Connecting to gateway at ${this.gatewayWsUrl}...`);
    this.ws = new WS(this.gatewayWsUrl);
    this.ws.on('open', () => { console.log('Gateway WebSocket connected'); this.reconnectAttempts = 0; });
    this.ws.on('message', data => this.handleGatewayMessage(data.toString()));
    this.ws.on('close', () => { console.log('Gateway WebSocket closed'); this.connected = false; this._failPendingRpcs('gateway disconnected'); this.lens?.reset(); this.broadcastGatewayStatus(false); if (!this._closed) this.scheduleReconnect(); });
    this.ws.on('error', err => console.error('Gateway WebSocket error:', err.message));
  }

  handleGatewayMessage(data) {
    this.debugLogger.logFrame('GW→SRV', data);
    let msg;
    try { msg = JSON.parse(data); } catch { console.error('Invalid JSON from gateway:', data); return; }

    // Responses to the connector's own RPCs (request()) are not browser traffic.
    if (msg.type === 'res' && this._rpc.has(msg.id)) {
      const pending = this._rpc.get(msg.id);
      this._rpc.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.payload);
      else pending.reject(new Error(msg.error?.message || `${pending.method} failed`));
      return;
    }

    // Responses to browser session requests the lens filters (roster, search, groups).
    if (msg.type === 'res' && this.lens?.ownsResponse(msg.id)) {
      this.broadcastToBrowsers(JSON.stringify(this.lens.response(msg)));
      return;
    }

    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const identity = loadOrCreateDeviceIdentity(path.join(this.dataDir, 'device-identity.json'));
      const device = buildDeviceAuth(identity, { clientId: 'gateway-client', clientMode: 'backend', role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], token: this.authToken, nonce: msg.payload?.nonce || '' });
      this.ws.send(JSON.stringify({ type: 'req', id: 'gw-connect-1', method: 'connect', params: { minProtocol: 3, maxProtocol: 4, client: { id: 'gateway-client', version: '0.1.0', platform: 'node', mode: 'backend' }, role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], device, auth: { token: this.authToken }, caps: ['tool-events'] } }));
      return;
    }
    if (msg.type === 'res' && msg.payload?.type === 'hello-ok') { console.log('Gateway handshake complete'); this.connected = true; this.broadcastGatewayStatus(true); this.sync?.onConnected(); this.request('sessions.subscribe', {}).catch(e => console.warn(`[lens] sessions.subscribe failed: ${e.message}`)); this.lens?.seed().catch(e => console.warn(`[lens] seed failed: ${e.message}`)); }
    // Session events arrive through the connector's own subscription; the lens filters them
    // for the browser (session.message only for chats a browser subscribed to).
    if (msg.type === 'event' && (msg.event === 'sessions.changed' || msg.event === 'session.message')) {
      if (msg.event === 'sessions.changed') this.sync?.onSessionsChanged(msg.payload);
      const frame = msg.event === 'sessions.changed' ? this.lens?.sessionsChanged(msg.payload) : this.lens?.sessionMessage(msg.payload);
      if (frame) this.broadcastToBrowsers(JSON.stringify(frame));
      return;
    }
    // Run events of sessions ClawChats doesn't show (channels, cron, subagents) never
    // leave the connector.
    if (msg.type === 'event' && RUN_EVENTS.has(msg.event) && this.lens && msg.payload?.sessionKey && !this.lens.forwardsRunEvent(msg.payload.sessionKey)) {
      return;
    }
    // Raw chat/agent events pass through; the browser builds live runs (frontend/live-run.js).
    this.broadcastToBrowsers(data);
  }

  // Gateway RPC from the connector itself; resolves with the response payload.
  request(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws || this.ws.readyState !== 1) return reject(new Error('gateway not connected'));
      const id = `cc-rpc-${++this._rpcSeq}`;
      const timer = setTimeout(() => { this._rpc.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this._rpc.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  _failPendingRpcs(reason) {
    for (const [id, p] of this._rpc) { clearTimeout(p.timer); p.reject(new Error(reason)); this._rpc.delete(id); }
  }

  broadcastToBrowsers(data) {
    this.debugLogger.logFrame('SRV→BR', data);
    for (const client of this.browserClients.keys()) { if (client.readyState === WS.OPEN) client.send(data); }
    for (const fn of this._externalBroadcastTargets) { try { fn(data); } catch { /* target disconnected */ } }
  }

  broadcastGatewayStatus(connected) {
    this.broadcastToBrowsers(JSON.stringify({ type: 'clawchats', event: 'gateway-status', connected }));
  }

  /** A frame from a browser: the lens may rewrite it or answer it itself. */
  forwardFromBrowser(data) {
    const out = this.lens ? this.lens.outbound(data) : data;
    if (out) this.sendToGateway(out);
  }

  sendToGateway(data) {
    this.debugLogger.logFrame('SRV→GW', data);
    if (this.ws?.readyState === WS.OPEN) this.ws.send(data);
    else console.error('Cannot send to gateway: not connected');
  }

  scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    console.log(`Reconnecting to gateway in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this.connect(); }, delay);
  }

  /**
   * Permanent shutdown (plugin stop/reload): no reconnects, pending RPCs fail, socket closed.
   * Without this the gateway's plugin drain waits forever on the open WebSocket.
   */
  close() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._failPendingRpcs('connector stopping');
    this.connected = false;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners('message');
      ws.on('error', () => {});
      try { ws.readyState === WS.CONNECTING ? ws.terminate() : ws.close(1001, 'connector stopping'); } catch { /* already closed */ }
      // Don't let a half-closed socket hold the drain open.
      setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 2000).unref?.();
    }
    this.browserClients.clear();
    this._externalBroadcastTargets = [];
  }

  addBrowserClient(ws) {
    this.browserClients.set(ws, {});
    if (ws.readyState === WS.OPEN) {
      ws.send(JSON.stringify({ type: 'clawchats', event: 'gateway-status', connected: this.connected }));
    }
  }

  removeBrowserClient(ws) { this.browserClients.delete(ws); }


  addBroadcastTarget(fn) { this._externalBroadcastTargets.push(fn); }
  removeBroadcastTarget(fn) { this._externalBroadcastTargets = this._externalBroadcastTargets.filter(f => f !== fn); }
}
