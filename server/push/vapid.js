// VAPID tokens per push service. The ClawChats-wide VAPID key lives on the signal server, which signs a JWT for one
// push service origin (exp ≤ 12 h) when this connector asks over its authenticated signaling link. Tokens are cached
// and renewed an hour before they expire, so the signal server sees about two requests a day per push service and
// nothing about when messages are sent. A local key (push-dev.json, tests and QA only) signs here instead.
import { signVapidJwt, vapidPublicKey } from './web-push.js';

const RENEW_BEFORE_MS = 60 * 60_000;

export class VapidTokens {
  /** @param {{ fetchToken: (audience: string) => Promise<{ jwt: string, exp: number, publicKey: string }>, now?: () => number }} o */
  constructor({ fetchToken, now = Date.now }) {
    this.fetchToken = fetchToken;
    this.now = now;
    this.cache = new Map(); // audience -> { jwt, exp (s), publicKey }
    this.inflight = new Map();
  }

  async get(audience) {
    const hit = this.cache.get(audience);
    if (hit && hit.exp * 1000 - this.now() > RENEW_BEFORE_MS) return hit;
    if (this.inflight.has(audience)) return this.inflight.get(audience);
    const p = this.fetchToken(audience).then(t => {
      if (!t?.jwt || !t?.publicKey || !Number.isFinite(t.exp)) throw new Error('signal server sent no VAPID token');
      this.cache.set(audience, t);
      return t;
    }).finally(() => this.inflight.delete(audience));
    this.inflight.set(audience, p);
    try { return await p; }
    catch (e) { if (hit && hit.exp * 1000 > this.now()) return hit; throw e; } // still valid: use it while renewal fails
  }

  /** A token went bad at the push service (401/403): ask again next time. */
  drop(audience) { this.cache.delete(audience); }
}

/** fetchToken with a local key: { privateKey (base64url d), subject }. */
export function localVapid({ privateKey, subject = 'mailto:support@clawchats.ai' }) {
  const publicKey = vapidPublicKey(privateKey);
  return {
    publicKey,
    fetchToken: async audience => {
      const jwt = signVapidJwt({ audience, subject, privateKey });
      return { jwt, exp: JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).exp, publicKey };
    },
  };
}
