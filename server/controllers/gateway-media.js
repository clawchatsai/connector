import http from 'node:http';
import { sendError } from '../util/http.js';

// Agent-delivered media (`MEDIA:` lines) lives in the gateway's outgoing-media store and
// is referenced from transcripts as /api/chat/media/outgoing/<session>/<id>/<variant>.
// That route needs the gateway token, which the browser doesn't have; the connector
// fetches it on the browser's behalf. Only that route prefix is proxied.
const ALLOWED_PREFIX = '/api/chat/media/outgoing/';

export function createGatewayMediaHandler({ gatewayWsUrl, gatewayToken }) {
  const base = new URL(gatewayWsUrl.replace(/^ws/, 'http'));
  return function handleGatewayMedia(req, res, query) {
    const target = query.u || '';
    if (!target.startsWith(ALLOWED_PREFIX) || target.includes('..')) return sendError(res, 400, 'Unsupported media URL');
    const upstream = http.request({
      hostname: base.hostname, port: base.port, path: target, method: 'GET',
      headers: { Authorization: `Bearer ${gatewayToken}` },
    }, up => {
      const headers = { 'Cache-Control': 'private, max-age=86400' };
      for (const h of ['content-type', 'content-length', 'content-disposition']) if (up.headers[h]) headers[h] = up.headers[h];
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
    });
    upstream.on('error', e => { if (!res.headersSent) sendError(res, 502, `Gateway media: ${e.message}`); else res.destroy(); });
    upstream.end();
  };
}
