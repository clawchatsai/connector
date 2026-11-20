import http from 'node:http';
import { send, sendError } from '../util/http.js';

// Sandboxed dashboard widgets (html, canvas, MCP apps), as the Control UI hosts them: the browser reads the
// widget's HTML itself and hands it by value to the gateway's sandbox proxy shell, which renders it in an
// opaque inner frame. A ClawChats browser can't reach the gateway origin, so the connector reads both for it:
//
// - the widget document, /__openclaw__/board/<scope>/<name>/…?bt=<view ticket> on the gateway port. The view
//   ticket (minted by board.get for this browser) is the authorization; nothing here adds credentials.
// - the proxy shell, /mcp-app-sandbox?csp=…&v=… on the gateway's sandbox port (mcp.apps.sandboxPort, else the
//   gateway port + 1). It is public and holds no secrets; the browser runs it in an opaque-origin frame
//   (clawchats frontend/sandbox/widget-host.html) under the CSP returned here.
//
// The P2P RPC carries a status and a body, not headers, so the answer is JSON: { html, csp } where csp is the
// gateway's Content-Security-Policy for that document. Only these two route shapes pass.
const BOARD_PREFIX = '/__openclaw__/board/';
const SANDBOX_PATH = '/mcp-app-sandbox';
const MAX_BYTES = 10 * 1024 * 1024 + 64 * 1024; // the gateway's 10 MiB widget cap plus headroom
const TIMEOUT_MS = 30_000;

/** 'u' → { kind, path } for an allowed target, else null. */
export function parseBoardTarget(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.length > 16 * 1024) return null;
  // Before parsing: URL() resolves dot segments (also %2e%2e), which would hide a climb out of the route.
  if (/%2e|\.\.|\\|#/i.test(target.split('?')[0]) || target.includes('#')) return null;
  let url;
  try { url = new URL(target, 'http://127.0.0.1'); } catch { return null; }
  if (url.origin !== 'http://127.0.0.1') return null;
  const keys = [...url.searchParams.keys()];
  if (url.pathname.startsWith(BOARD_PREFIX) && url.pathname.length > BOARD_PREFIX.length) {
    const ticket = url.searchParams.get('bt');
    if (keys.length !== 1 || keys[0] !== 'bt' || !ticket) return null;
    return { kind: 'board', path: `${url.pathname}?bt=${encodeURIComponent(ticket)}` };
  }
  if (url.pathname === SANDBOX_PATH) {
    if (keys.some(k => k !== 'csp' && k !== 'v') || new Set(keys).size !== keys.length) return null;
    const q = new URLSearchParams();
    for (const k of ['csp', 'v']) if (url.searchParams.has(k)) q.set(k, url.searchParams.get(k));
    if ([...q.values()].some(v => !/^[A-Za-z0-9_-]*$/.test(v))) return null;
    return { kind: 'sandbox', path: q.size ? `${SANDBOX_PATH}?${q}` : SANDBOX_PATH };
  }
  return null;
}

/** The gateway's sandbox listener port (the gateway's resolveSandboxHostPort). */
export function resolveSandboxPort(gatewayPort, configuredPort) {
  const port = Number.isInteger(configuredPort) ? configuredPort : gatewayPort + 1;
  return port >= 1 && port <= 65535 && port !== gatewayPort ? port : null;
}

export function createGatewayBoardHandler({ gatewayWsUrl, sandboxPort: configuredSandboxPort, request = null }) {
  const base = new URL(gatewayWsUrl.replace(/^ws/, 'http'));
  const gatewayPort = Number(base.port) || 80;
  const sandboxPort = resolveSandboxPort(gatewayPort, configuredSandboxPort);
  const client = request || http.request;
  return function handleGatewayBoard(req, res, query) {
    const target = parseBoardTarget(query.u || '');
    if (!target) return sendError(res, 400, 'Unsupported widget URL');
    const port = target.kind === 'board' ? gatewayPort : sandboxPort;
    if (!port) return sendError(res, 503, 'Widget sandbox host is unavailable');
    let done = false;
    const finish = (status, body) => { if (!done) { done = true; status === 200 ? send(res, 200, body) : sendError(res, status, body); } };
    const upstream = client({
      hostname: base.hostname, port, path: target.path, method: 'GET',
      headers: { Accept: 'text/html' },
    }, up => {
      const status = up.statusCode || 502;
      if (status !== 200) { up.resume(); return finish(status, `widget content request failed (${status})`); }
      const chunks = []; let size = 0;
      up.on('data', c => {
        size += c.length;
        if (size > MAX_BYTES) { up.destroy(); finish(413, 'widget HTML exceeds 10 MiB; regenerate a smaller widget'); return; }
        chunks.push(c);
      });
      up.on('end', () => finish(200, { html: Buffer.concat(chunks).toString('utf8'), csp: String(up.headers['content-security-policy'] || '') }));
      up.on('error', e => finish(502, `widget content: ${e.message}`));
    });
    upstream.setTimeout(TIMEOUT_MS, () => { upstream.destroy(); finish(504, 'widget content request timed out'); });
    // ECONNREFUSED on the sandbox port: the gateway starts that listener only once a widget needs it.
    upstream.on('error', e => finish(502, `widget content: ${e.message}`));
    upstream.end();
  };
}
