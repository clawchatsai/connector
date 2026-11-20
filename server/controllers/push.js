// Push notification routes (server/push/). Reached only over the owner's signed-in DataChannel (src/index.ts),
// so only the owner's devices can subscribe; gateway-sharing peers have no route here.
//
//   GET    /api/push                 { enabled, publicKey, devices }       this gateway's subscribed devices
//   POST   /api/push/subscribe       { subscription, deviceLabel, mobile, prefs? } → { device }   (idempotent)
//   POST   /api/push/unsubscribe     { endpoint }                           this device stops getting pushes
//   PUT    /api/push/devices/:id     { prefs }  → { device }
//   DELETE /api/push/devices/:id
import { send, sendError, parseBody, matchRoute } from '../util/http.js';
import { pushAudience } from '../push/web-push.js';
import { publicDevice, PREF_KEYS } from '../push/store.js';

const B64U = /^[A-Za-z0-9_-]+={0,2}$/;

export function createPushHandlers(push) {
  return async function handlePush(req, res, method, urlPath) {
    if (!urlPath.startsWith('/api/push')) return false;
    let p;
    if (method === 'GET' && urlPath === '/api/push') {
      send(res, 200, { enabled: true, publicKey: push.localPublicKey, devices: push.store.list().map(publicDevice) });
      return true;
    }
    if (method === 'POST' && urlPath === '/api/push/subscribe') {
      const { subscription, deviceLabel, mobile, prefs } = await parseBody(req);
      const endpoint = subscription?.endpoint, keys = subscription?.keys;
      if (typeof endpoint !== 'string' || endpoint.length > 1024 || !pushAudience(endpoint)) { sendError(res, 400, 'Not a supported push service'); return true; }
      if (!B64U.test(keys?.p256dh || '') || !B64U.test(keys?.auth || '')) { sendError(res, 400, 'Subscription keys missing'); return true; }
      try { send(res, 200, { device: publicDevice(push.store.upsert({ endpoint, keys, deviceLabel, mobile: !!mobile, prefs: cleanBody(prefs) })) }); }
      catch (e) { sendError(res, 400, e.message); }
      return true;
    }
    if (method === 'POST' && urlPath === '/api/push/unsubscribe') {
      const { endpoint } = await parseBody(req);
      send(res, 200, { ok: true, removed: typeof endpoint === 'string' && push.store.removeByEndpoint(endpoint) });
      return true;
    }
    if ((p = matchRoute(method, urlPath, 'PUT /api/push/devices/:id'))) {
      const d = push.store.setPrefs(p.id, cleanBody((await parseBody(req)).prefs));
      d ? send(res, 200, { device: publicDevice(d) }) : sendError(res, 404, 'No such device');
      return true;
    }
    if ((p = matchRoute(method, urlPath, 'DELETE /api/push/devices/:id'))) {
      send(res, 200, { ok: true, removed: push.store.remove(p.id) });
      return true;
    }
    return false;
  };
}

function cleanBody(prefs) {
  if (!prefs || typeof prefs !== 'object') return undefined;
  const out = {};
  for (const k of PREF_KEYS) if (typeof prefs[k] === 'boolean') out[k] = prefs[k];
  return out;
}
