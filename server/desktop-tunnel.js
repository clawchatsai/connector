// Desktop tunnel: one extra DataChannel per Desktop view, piped to the gateway's desktop WebSocket.
//
// The Control UI's Desktop panel opens a raw binary WebSocket straight to the gateway
// (/desktop/observe?token=…, minted by the desktop.observe RPC). A ClawChats browser can't reach
// the gateway directly, so it opens a DataChannel labelled "tunnel:<that path>" on its existing
// WebRTC connection; this module connects it to the gateway on loopback and copies bytes both ways.
//
// Rules:
// - Only the desktop stream paths, with only a token parameter: the tunnel can't reach any other
//   gateway URL. The gateway checks the one-time token itself; nothing here holds credentials.
// - Callers only pass channels from an authenticated browser connection (never a share peer).
// - Gateway → browser data goes in pieces of CHUNK bytes, so chat on the main channel interleaves.
// - Backpressure: when the channel has more than HIGH_WATER queued, stop reading the gateway
//   socket until it drains below LOW_WATER. Memory stays bounded on a slow or relayed link.
// - Text messages on the channel are control frames: the connector sends one
//   {"type":"close","code","reason"} before closing, so the viewer can show why (WebSocket close
//   codes don't survive a DataChannel close).

import { WebSocket as WS } from 'ws';

export const TUNNEL_LABEL_PREFIX = 'tunnel:';
const ALLOWED_PATHS = new Set(['/desktop/observe', '/desktop/audio']);
export const CHUNK = 16 * 1024;
export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 256 * 1024;
// Browser → gateway bytes buffered while the gateway socket is still connecting.
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_LABEL_LENGTH = 2048;

/** "tunnel:/desktop/observe?token=…" → "/desktop/observe?token=…", or null when not allowed. */
export function parseTunnelLabel(label) {
  if (typeof label !== 'string' || !label.startsWith(TUNNEL_LABEL_PREFIX) || label.length > MAX_LABEL_LENGTH) return null;
  const raw = label.slice(TUNNEL_LABEL_PREFIX.length);
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  let url;
  try { url = new URL(raw, 'http://127.0.0.1'); } catch { return null; }
  if (url.origin !== 'http://127.0.0.1' || !ALLOWED_PATHS.has(url.pathname) || url.hash) return null;
  const keys = [...url.searchParams.keys()];
  const token = url.searchParams.get('token');
  if (keys.length !== 1 || keys[0] !== 'token' || !token) return null;
  return `${url.pathname}?token=${encodeURIComponent(token)}`;
}

/** ws://host:port (the gateway client's URL) + path → the gateway desktop socket URL. */
export function gatewaySocketUrl(gatewayUrl, path) {
  const base = new URL(gatewayUrl);
  return new URL(path, `${base.protocol}//${base.host}`).toString();
}

const toBuffer = data => Buffer.isBuffer(data) ? data
  : data instanceof ArrayBuffer ? Buffer.from(data)
  : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  : null;

/**
 * Pipe a browser DataChannel (W3C RTCDataChannel API: send, close, readyState, bufferedAmount,
 * onmessage, onclose, onbufferedamountlow) to the gateway desktop socket its label names.
 * Returns a handle with close(), or null when the label isn't an allowed tunnel (channel closed).
 */
export function openDesktopTunnel(dc, { gatewayUrl, WebSocketImpl = WS, log = console } = {}) {
  const path = parseTunnelLabel(dc.label);
  if (!path) {
    try { dc.close(); } catch { /* gone */ }
    return null;
  }
  try { dc.binaryType = 'arraybuffer'; } catch { /* read-only in some polyfills */ }
  dc.bufferedAmountLowThreshold = LOW_WATER;
  // A channel can arrive before it's open; the gateway speaks first (RFB), so connect once it is.
  if (dc.readyState === 'connecting') {
    const handle = { closed: false, inner: null, close() { this.closed = true; this.inner?.close(); try { dc.close(); } catch { /* gone */ } } };
    dc.onopen = () => { if (!handle.closed) handle.inner = pipe(dc, path, { gatewayUrl, WebSocketImpl, log }); };
    dc.onclose = () => { handle.closed = true; };
    return handle;
  }
  return pipe(dc, path, { gatewayUrl, WebSocketImpl, log });
}

function pipe(dc, path, { gatewayUrl, WebSocketImpl, log }) {
  let closed = false;
  const sendControl = (code, reason) => {
    try { if (dc.readyState === 'open') dc.send(JSON.stringify({ type: 'close', code, reason: String(reason || '').slice(0, 200) })); }
    catch { /* channel already gone */ }
  };
  const ws = new WebSocketImpl(gatewaySocketUrl(gatewayUrl, path), { perMessageDeflate: false });
  let pending = [];
  let pendingBytes = 0;
  let paused = false;

  const finish = (code, reason, { fromChannel = false } = {}) => {
    if (closed) return;
    closed = true;
    pending = [];
    if (!fromChannel) {
      sendControl(code, reason);
      try { dc.close(); } catch { /* gone */ }
    }
    try {
      if (ws.readyState === WebSocketImpl.OPEN) ws.close(1000);
      else if (ws.readyState === WebSocketImpl.CONNECTING) ws.terminate();
    } catch { /* gone */ }
  };

  const resume = () => {
    if (!paused || closed) return;
    paused = false;
    try { ws.resume(); } catch { /* closed */ }
  };
  dc.onbufferedamountlow = resume;

  ws.on('open', () => {
    for (const buf of pending) ws.send(buf);
    pending = [];
    pendingBytes = 0;
  });
  ws.on('message', (data) => {
    if (closed || dc.readyState !== 'open') return;
    const buf = Array.isArray(data) ? Buffer.concat(data) : toBuffer(data) ?? Buffer.from(String(data));
    try {
      for (let i = 0; i < buf.length; i += CHUNK) dc.send(buf.subarray(i, Math.min(i + CHUNK, buf.length)));
    } catch (e) {
      finish(1011, `tunnel send failed: ${e.message}`);
      return;
    }
    if (!paused && dc.bufferedAmount > HIGH_WATER) {
      paused = true;
      ws.pause();
      // The low-water event can fire before the pause took effect; check once more.
      if (dc.bufferedAmount <= LOW_WATER) resume();
    }
  });
  ws.on('unexpected-response', (_req, res) => {
    finish(1006, `the gateway refused the desktop stream (HTTP ${res.statusCode})`);
    res.resume?.();
  });
  ws.on('close', (code, reason) => finish(code || 1006, reason?.toString?.() || ''));
  ws.on('error', (e) => {
    log.warn?.(`[desktop-tunnel] gateway socket error: ${e.message}`);
    finish(1006, '');
  });

  dc.onmessage = (event) => {
    if (closed) return;
    if (typeof event.data === 'string') return; // the browser sends no control frames yet
    const buf = toBuffer(event.data);
    if (!buf) return;
    if (ws.readyState === WebSocketImpl.OPEN) { ws.send(buf); return; }
    pendingBytes += buf.length;
    if (pendingBytes > MAX_PENDING_BYTES) { finish(1009, 'tunnel buffer full'); return; }
    pending.push(Buffer.from(buf)); // copy: the channel may reuse its buffer
  };
  dc.onclose = () => finish(1000, '', { fromChannel: true });

  return { close: () => finish(1000, 'tunnel closed'), get closed() { return closed; } };
}
