import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { send } from '../util/http.js';

/**
 * List available OpenClaw agents.
 * Keeps fs.readdirSync out of the HTTP router (server/index.js).
 */
export function handleAgents(req, res) {
  try {
    const agentsDir = path.join(os.homedir(), '.openclaw', 'agents');
    const agents = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    send(res, 200, { agents });
  } catch {
    send(res, 200, { agents: ['main'] });
  }
}
