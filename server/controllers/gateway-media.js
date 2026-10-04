import http from 'node:http';
import { sendError } from '../util/http.js';

// Agent-delivered media (`MEDIA:` lines) lives in the gateway's outgoing-media store and
// is referenced from transcripts as /api/chat/media/outgoing/<session>/<id>/<variant>.
// That route needs the gateway token, which the browser doesn't have; the connector
// fetches it on the browser's behalf.
//
// User-sent attachments live in the gateway's inbound media store (`media://inbound/<file>`),
// served by the Control UI's authenticated assistant-media route:
//   /__<platform>__/assistant-media?source=media://inbound/<file>&sessionKey=…&agentId=…
// The same route serves raw `MEDIA:<path>` lines left in assistant text (claude-cli replies),
// which the Control UI parses client-side (chat-message-local-media.ts). Local sources need a
// sessionKey: the gateway then applies that session's file-read policy (it refuses e.g.
// /etc/passwd and its own config). `meta=1` (a GET returning the availability JSON the Control
// UI uses for "Unavailable · <reason>") passes; `allow` (admin outside-folder grant, POST) and
// `mediaTicket` don't. The route is matched by shape (no brand string).
const ALLOWED_PREFIX = '/api/chat/media/outgoing/';
const INBOUND_ROUTE = /^\/__[a-z0-9-]+__\/assistant-media\?/;
const INBOUND_SOURCE = /^media:\/\/inbound\/[^/?#\\]+$/;
const LOCAL_SOURCE = /^(?:\/|~\/|\.\/|file:|[a-zA-Z]:[\\/])|^[^:]+$/;

export function isAllowedMediaTarget(target) {
  if (typeof target !== 'string' || target.includes('..')) return false;
  if (target.startsWith(ALLOWED_PREFIX)) return true;
  if (!INBOUND_ROUTE.test(target)) return false;
  const q = new URLSearchParams(target.slice(target.indexOf('?') + 1));
  if ((q.has('meta') && q.getAll('meta').join() !== '1') || q.has('allow') || q.has('mediaTicket')) return false;
  const source = q.get('source') || '';
  if (INBOUND_SOURCE.test(source)) return true;
  return !!source && !source.includes('\0') && LOCAL_SOURCE.test(source) && !!q.get('sessionKey');
}

export function createGatewayMediaHandler({ gatewayWsUrl, gatewayToken }) {
  const base = new URL(gatewayWsUrl.replace(/^ws/, 'http'));
  return function handleGatewayMedia(req, res, query) {
    const target = query.u || '';
    if (!isAllowedMediaTarget(target)) return sendError(res, 400, 'Unsupported media URL');
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
