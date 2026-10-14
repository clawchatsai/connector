import http from 'node:http';
import { parseBody, send, sendError } from '../util/http.js';

// Realtime Talk over WebRTC: `talk.client.create` returns an `offerUrl` that is a route of the
// gateway's own HTTP server (e.g. /plugins/openai/realtime/calls). The Control UI reaches it
// directly; a ClawChats browser has no HTTP path to the gateway, only this DataChannel. The
// browser posts its SDP offer here and the connector relays it to that gateway route.
//
// The only credential involved is the one-time `clientSecret` the gateway minted for this call
// (sent as the route's Bearer token, as the Control UI does); the gateway token never leaves
// the connector. Only the gateway's realtime broker routes are reachable.
const OFFER_PATH = /^\/plugins\/[a-z0-9][a-z0-9-]*\/realtime\/calls$/;
const MAX_SDP_BYTES = 64 * 1024;
const MAX_ANSWER_BYTES = 256 * 1024;
const OFFER_TIMEOUT_MS = 30_000;
// Provider-specific extras (`offerHeaders`) may only be X-* headers.
const EXTRA_HEADER = /^x-[a-z0-9-]+$/i;

export function isAllowedOfferPath(p) {
  return typeof p === 'string' && OFFER_PATH.test(p);
}

export function createTalkOfferHandler({ gatewayWsUrl }) {
  const base = new URL(gatewayWsUrl.replace(/^ws/, 'http'));
  return async function handleTalkOffer(req, res) {
    let body;
    try { body = await parseBody(req); } catch { return sendError(res, 400, 'Invalid JSON'); }
    const { path, sdp, clientSecret, headers } = body || {};
    if (!isAllowedOfferPath(path)) return sendError(res, 400, 'Unsupported realtime offer route');
    if (typeof sdp !== 'string' || !sdp.trim() || Buffer.byteLength(sdp) > MAX_SDP_BYTES) return sendError(res, 400, 'SDP offer required');
    if (typeof clientSecret !== 'string' || !clientSecret || /\s/.test(clientSecret)) return sendError(res, 400, 'Realtime session token required');
    const outHeaders = { 'Content-Type': 'application/sdp', 'Content-Length': String(Buffer.byteLength(sdp)), Authorization: `Bearer ${clientSecret}` };
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) if (EXTRA_HEADER.test(k) && typeof v === 'string') outHeaders[k] = v;
    }
    await new Promise(resolve => {
      const upstream = http.request({ hostname: base.hostname, port: base.port, path, method: 'POST', headers: outHeaders, timeout: OFFER_TIMEOUT_MS }, up => {
        const chunks = [];
        let size = 0;
        up.on('data', c => {
          size += c.length;
          if (size > MAX_ANSWER_BYTES) { up.destroy(); if (!res.headersSent) sendError(res, 502, 'Realtime answer too large'); return resolve(); }
          chunks.push(c);
        });
        up.on('end', () => {
          if (!res.headersSent) send(res, 200, { status: up.statusCode || 502, body: Buffer.concat(chunks).toString('utf8') });
          resolve();
        });
        up.on('error', e => { if (!res.headersSent) sendError(res, 502, `Gateway realtime offer: ${e.message}`); resolve(); });
      });
      upstream.on('timeout', () => upstream.destroy(new Error('timed out')));
      upstream.on('error', e => { if (!res.headersSent) sendError(res, 502, `Gateway realtime offer: ${e.message}`); resolve(); });
      upstream.end(sdp);
    });
  };
}
