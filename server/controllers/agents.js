import fs from 'node:fs';
import path from 'node:path';
import { send } from '../util/http.js';
import { STATE_DIR } from '../config.js';

/**
 * List available OpenClaw agents.
 * Keeps fs.readdirSync out of the HTTP router (server/index.js).
 */
export function handleAgents(req, res) {
  try {
    const agentsDir = path.join(STATE_DIR, 'agents');
    const agents = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    send(res, 200, { agents });
  } catch {
    send(res, 200, { agents: ['main'] });
  }
}
