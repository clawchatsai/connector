import { WebSocket as WS } from 'ws';

// The gateway sends *.approval.requested / *.approval.resolved only to "approval clients"
// (src/gateway/server-request-context.ts canDeliverApprovals: the Control UI's client id, or a
// connection declaring the `approvals` cap). Being one also changes routing: while any approval
// client is connected, an approval waits for a decision instead of expiring at once with
// "no-approval-route". The connector's main connection is always up, so it must not be one.
// Like an open Control UI tab, this second connection declares the cap only while a browser is
// attached (GatewayClient.browsersChanged). Only approval events leave it; everything else the
// gateway broadcasts to it is dropped (the main connection already delivers those).
export const APPROVAL_EVENT_RE = /^(exec|plugin|openclaw)\.approval\.(requested|resolved)$/;

export class ApprovalClient {
  /**
   * @param {object} o
   * @param {string} o.gatewayWsUrl
   * @param {(nonce: string) => object} o.connectParams  connect params for this socket (caps: ['approvals'])
   * @param {(data: string) => void} o.onEvent           an approval event frame, as received
   * @param {{ logFrame(direction: string, data: string): void }} o.debugLogger
   */
  constructor({ gatewayWsUrl, connectParams, onEvent, debugLogger }) {
    this.gatewayWsUrl = gatewayWsUrl;
    this.connectParams = connectParams;
    this.onEvent = onEvent;
    this.debugLogger = debugLogger;
    this.ws = null;
    this.running = false;
    this.connected = false;
    this.reconnectAttempts = 0;
    this._reconnectTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempts = 0;
    this._connect();
  }

  stop() {
    this.running = false;
    this.connected = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners('message');
      ws.removeAllListeners('close');
      ws.on('error', () => {});
      try { ws.readyState === WS.CONNECTING ? ws.terminate() : ws.close(1000, 'no browser attached'); } catch { /* already closed */ }
      setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 2000).unref?.();
    }
  }

  _connect() {
    if (!this.running) return;
    const ws = new WS(this.gatewayWsUrl);
    this.ws = ws;
    ws.on('open', () => { this.reconnectAttempts = 0; });
    ws.on('message', data => this._onMessage(ws, data.toString()));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      if (this.running) this._scheduleReconnect();
    });
    ws.on('error', err => console.error('[approvals] gateway WebSocket error:', err.message));
  }

  _onMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      ws.send(JSON.stringify({ type: 'req', id: 'gw-approvals-connect', method: 'connect', params: this.connectParams(msg.payload?.nonce || '') }));
      return;
    }
    if (msg.type === 'res' && msg.id === 'gw-approvals-connect') {
      this.connected = !!msg.ok;
      if (msg.ok) console.log('[approvals] approval-client connection ready');
      else console.warn(`[approvals] connect failed: ${msg.error?.message || 'unknown error'}`);
      return;
    }
    if (msg.type === 'event' && APPROVAL_EVENT_RE.test(msg.event || '')) {
      this.debugLogger?.logFrame('GW→SRV', data);
      this.onEvent(data);
    }
  }

  _scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._connect(); }, delay);
  }
}
