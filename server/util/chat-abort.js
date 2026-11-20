// chat.abort with the physical-session fence (2026.11.5+): `sessionId` next to the exact `runId` means a Stop lands
// only on the session the run started in, never on the one that replaced it (owner hit /new, the session was made
// again). 2026.9.7's ChatAbortParams is a closed object and refuses the field, so it's sent only to a gateway that
// takes it: by the hello-ok version, or, when that's unknown, by trying once and falling back for this connection.

const FENCE_SINCE = [2026, 11, 5];

/** [year, month, patch] of "2026.11.6" / "2026.11.5-beta.3" / "v2026.11.6", or null. */
export function parseGatewayVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? m.slice(1, 4).map(Number) : null;
}

const atLeast = (v, min) => { for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i]; return true; };

const NO_HELLO = {};

/**
 * @param {(m: string, p: object, t?: number) => Promise<any>} request  gateway RPC
 * @param {{ hello?: () => object|null }} o  the current connection's hello-ok payload (gateway.js), a new object per connect
 */
export function createChatAbort(request, { hello = () => null } = {}) {
  let refusedBy = null; // the connection (hello) that refused sessionId
  const conn = () => hello() || NO_HELLO;
  const supported = () => {
    if (refusedBy === conn()) return false;
    const v = parseGatewayVersion(hello()?.server?.version);
    return v ? atLeast(v, FENCE_SINCE) : true; // unknown: try it
  };
  return {
    supported,
    /** The session's physical id, to fence a later abort (null on a gateway without the fence, or on failure). */
    async sessionIdOf(sessionKey) {
      if (!supported()) return null;
      const r = await request('sessions.describe', { key: sessionKey }, 5000).catch(() => null);
      return typeof r?.session?.sessionId === 'string' && r.session.sessionId ? r.session.sessionId : null;
    },
    /** Abort one run; `sessionId` goes along when the gateway takes it. */
    async abort({ sessionKey, runId, sessionId }) {
      if (sessionId && runId && supported()) {
        const c = conn();
        try { return await request('chat.abort', { sessionKey, runId, sessionId }); }
        catch (e) {
          // Only the schema refusal (9.7: "invalid chat.abort params: at root: unexpected property 'sessionId'"); a fence
          // that doesn't match must never be retried without it.
          if (e?.gatewayCode !== 'INVALID_REQUEST' || !/unexpected property\W+sessionId/.test(e.message || '')) throw e;
          refusedBy = c;
        }
      }
      return request('chat.abort', { sessionKey, runId });
    },
  };
}
