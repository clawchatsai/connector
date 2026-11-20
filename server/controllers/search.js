// Chat search over the connector's own index (server/search/). The browser falls back to the
// gateway's sessions.search when these routes are missing (older connector) or answer 503.
//
//   GET  /api/search?q=&role=user|assistant&archived=0|1&limit=   one row per chat, best first
//   GET  /api/search/status[?detail=1]                            coverage; detail adds per-chat rows
//   POST /api/search/rebuild                                      drop the index and build it again

import http from 'node:http';
import { send, sendError } from '../util/http.js';

const ROLES = new Set(['user', 'assistant']);

export function createSearchHandlers({ store, indexer }) {
  function unavailable(res) { return sendError(res, 503, 'Search index unavailable'); }

  function handleSearch(req, res, query) {
    if (!store) return unavailable(res);
    const q = String(query.q || '').trim();
    if (!q) return sendError(res, 400, 'Missing ?q=');
    const role = ROLES.has(query.role) ? query.role : null;
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const { results, truncated } = store.search({ q, role, archived: query.archived !== '0', limit });
    return send(res, 200, { results, truncated, status: indexer.status() });
  }

  function handleStatus(req, res, query) {
    if (!store) return unavailable(res);
    return send(res, 200, { status: indexer.status(), ...(query.detail === '1' ? { chats: store.coverage() } : {}) });
  }

  async function handleRebuild(req, res) {
    if (!store) return unavailable(res);
    indexer.rebuild().catch(e => console.warn(`[search] rebuild: ${e.message}`));
    return send(res, 202, { status: indexer.status() });
  }

  return { handleSearch, handleStatus, handleRebuild };
}

/**
 * Text of an inbound media file (selection comments), read through the gateway's authenticated
 * assistant-media route (controllers/gateway-media.js). null when the gateway no longer has the
 * file; throws on anything else so the chat is retried.
 */
export function createInboundTextFetcher({ gatewayWsUrl, gatewayToken, maxBytes = 256 * 1024, timeoutMs = 15_000 }) {
  const base = new URL(gatewayWsUrl.replace(/^ws/, 'http'));
  return function fetchInboundText(url, { sessionKey, field }) {
    const agentId = String(sessionKey || '').split(':')[1] || 'main';
    const q = new URLSearchParams({ source: url, sessionKey: sessionKey || '', agentId });
    const target = `/${field}__/assistant-media?${q}`;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: base.hostname, port: base.port, path: target, method: 'GET', headers: { Authorization: `Bearer ${gatewayToken}` }, timeout: timeoutMs }, up => {
        if (up.statusCode === 404 || up.statusCode === 410) { up.resume(); return resolve(null); }
        if (up.statusCode !== 200) { up.resume(); return reject(new Error(`comment file: HTTP ${up.statusCode}`)); }
        const chunks = [];
        let size = 0;
        up.on('data', c => { size += c.length; if (size <= maxBytes) chunks.push(c); });
        up.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        up.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('comment file: timed out')));
      req.on('error', reject);
      req.end();
    });
  };
}
