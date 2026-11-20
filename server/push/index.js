// Push notifications (server/push/): subscription store, presence, VAPID tokens and the notifier, put together for
// createApp. The plugin host supplies `requestVapid` (a VAPID token from the signal server over its signaling link).
//
// Test override (QA stacks, never needed in normal use): <dataDir>/push-dev.json
//   { "vapidPrivateKey": "<base64url d>", "vapidSubject": "mailto:…", "approvalEscalateMs": 20000, "presentIdleMs": 30000 }
// or env CLAWCHATS_PUSH_VAPID_PRIVATE_KEY / CLAWCHATS_PUSH_ESCALATE_MS. A local key signs VAPID tokens here, so a
// connector can push without the signal server's key (its browsers then subscribe with this key's public half).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PushStore } from './store.js';
import { Presence, PRESENT_IDLE_MS } from './presence.js';
import { VapidTokens, localVapid } from './vapid.js';
import { PushNotifier, APPROVAL_ESCALATE_MS } from './notifier.js';

function devConfig(dataDir) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(dataDir, 'push-dev.json'), 'utf8')) || {}; } catch { /* none */ }
  const env = process.env;
  return {
    vapidPrivateKey: env.CLAWCHATS_PUSH_VAPID_PRIVATE_KEY || file.vapidPrivateKey || null,
    vapidSubject: file.vapidSubject || undefined,
    escalateMs: Number(env.CLAWCHATS_PUSH_ESCALATE_MS || file.approvalEscalateMs) || APPROVAL_ESCALATE_MS,
    idleMs: Number(file.presentIdleMs) || PRESENT_IDLE_MS,
  };
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {{ isTopLevel(key: string): boolean }} o.lens
 * @param {(method: string, params: object) => Promise<any>} o.request
 * @param {() => string} o.gatewayId
 * @param {((audience: string) => Promise<{ jwt: string, exp: number, publicKey: string }>) | undefined} o.requestVapid
 */
export function createPush({ dataDir, lens, request, gatewayId, requestVapid, log = console }) {
  const dev = devConfig(dataDir);
  const local = dev.vapidPrivateKey ? localVapid({ privateKey: dev.vapidPrivateKey, subject: dev.vapidSubject }) : null;
  if (local) log.warn?.('[push] using the local VAPID key from push-dev.json (test override)');
  const fetchToken = local?.fetchToken || requestVapid || (async () => { throw new Error('no signal server link'); });
  const store = new PushStore(path.join(dataDir, 'push-subscriptions.json'));
  const presence = new Presence({ idleMs: dev.idleMs });
  const vapid = new VapidTokens({ fetchToken });
  const notifier = new PushNotifier({ store, presence, vapid, lens, request, gatewayId, gatewayName: () => os.hostname(), escalateMs: dev.escalateMs, log });
  return {
    store, presence, notifier,
    /** The applicationServerKey browsers subscribe with when it isn't the signal server's (test override), else null. */
    localPublicKey: local?.publicKey || null,
    updatePresence(connectionId, msg) { presence.update(connectionId, msg); notifier.presenceChanged(); },
    removePresence(connectionId) { presence.remove(connectionId); notifier.presenceChanged(); },
  };
}
