// Room helper sessions: the sessions agents actually run in for a team chat, a member's working session
// (team.js) and a copy's guest session (peer/sharing.js). Nobody opened them as chats, so they're made as dock
// conversations (`sessions.create { surface: 'plugin-dock' }`, OpenClaw 2026.11.6+): the gateway leaves those out of
// the Control UI's chat list, its search and Workboard (`excludeDock`), while runs, owner, access and sharing stay
// those of an ordinary session. Before this they were plain chats and showed in every client but ClawChats (F5).
// Team chats need a gateway with the flag (Houman, 2026-11-22): on an older one this refuses, with a message.

import { parseGatewayVersion } from './util/chat-abort.js';

export const DOCK_SURFACE = 'plugin-dock';
export const TEAM_MIN_GATEWAY = [2026, 11, 6];
export const TEAM_UNSUPPORTED = `Team chats need OpenClaw ${TEAM_MIN_GATEWAY.join('.')} or newer on this gateway. Update OpenClaw (openclaw update) and try again.`;

/** A row the gateway keeps out of ordinary session lists (a dock conversation). */
export const isDockRow = row => !!row && (row.isDock === true || row.createdSurface === DOCK_SURFACE);

const atLeast = (v, min) => { for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i]; return true; };
const unsupported = () => Object.assign(new Error(TEAM_UNSUPPORTED), { code: 'gateway_too_old' });

/**
 * @param {object} opts
 * @param {(method: string, params: object, timeoutMs?: number) => Promise<any>} opts.request  gateway RPC
 * @param {() => string|null|undefined} [opts.gatewayVersion]  the connected gateway's version (hello-ok server.version)
 */
export function createHelperSessions({ request, gatewayVersion = () => null, log = console }) {
  return {
    /** false: the gateway is older than team chats need; null: its version is unknown (a create will tell). */
    supported() {
      const v = parseGatewayVersion(gatewayVersion());
      return v ? atLeast(v, TEAM_MIN_GATEWAY) : null;
    },

    /** Throws the "update OpenClaw" error on a gateway known to be too old. */
    assertSupported() {
      if (this.supported() === false) throw unsupported();
    },

    /** Make a helper session, hidden as a dock conversation. Same params as `sessions.create` otherwise. */
    async create({ key, agentId, label, cwd = null, permissionMode = null, toolOverrides = null }) {
      this.assertSupported();
      try {
        await request('sessions.create', {
          key, agentId, surface: DOCK_SURFACE,
          ...(label ? { label } : {}), ...(permissionMode ? { permissionMode } : {}), ...(toolOverrides ? { toolOverrides } : {}), ...(cwd ? { cwd } : {}),
        });
      } catch (e) {
        // A gateway that didn't say its version: one without the flag refuses it as an unknown property.
        if (/surface/.test(e.message) && /unexpected|additional|unknown|must NOT have/i.test(e.message)) throw unsupported();
        throw e;
      }
      return key;
    },

    /**
     * Delete helpers earlier connectors made as visible chats (F5). `candidates`: [{ key, kind, ...where }], the keys
     * the stores recorded when the connector made them (callers leave out rooms and chats a person turned into one).
     * Kept: rows already hidden, missing, or running (`busy(key)` or an active run). `forget(candidate)` runs after each
     * delete: the lane is made again, hidden, on its next turn. Returns { deleted, skipped }, each [{ key, kind, label, why? }];
     * every row is logged.
     */
    async cleanUp(candidates, { busy = () => false, forget = () => {} } = {}) {
      const deleted = [], skipped = [];
      for (const c of candidates) {
        const row = (await request('sessions.describe', { key: c.key }, 10_000).catch(() => null))?.session;
        if (!row || isDockRow(row)) continue;
        const label = row.label || row.displayName || '';
        if (row.hasActiveRun || busy(c.key)) {
          skipped.push({ key: c.key, kind: c.kind, label, why: 'running' });
          log.warn?.(`[helpers] kept ${c.key} (${c.kind}, "${label}"): running; deleted on the next start`);
          continue;
        }
        try {
          await request('sessions.delete', { key: c.key, ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}) });
        } catch (e) {
          skipped.push({ key: c.key, kind: c.kind, label, why: e.message });
          log.warn?.(`[helpers] couldn't delete ${c.key} (${c.kind}, "${label}"): ${e.message}`);
          continue;
        }
        forget(c);
        deleted.push({ key: c.key, kind: c.kind, label });
        log.info?.(`[helpers] deleted visible ${c.kind} session ${c.key} ("${label}")`);
      }
      if (deleted.length || skipped.length) log.info?.(`[helpers] cleanup: ${deleted.length} deleted, ${skipped.length} kept`);
      return { deleted, skipped };
    },
  };
}
