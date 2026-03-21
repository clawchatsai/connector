import fs from 'node:fs';
import path from 'node:path';
import { send } from '../util/http.js';

/**
 * Factory that returns settings GET/PUT handlers bound to a specific settings file path.
 * Keeps file I/O out of the HTTP router (server/index.js).
 */
export function createSettingsHandlers(settingsFile) {
  function handleGetSettings(req, res) {
    try {
      send(res, 200, fs.existsSync(settingsFile)
        ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
        : {});
    } catch {
      send(res, 200, {});
    }
  }

  async function handleSaveSettings(req, res, parseBody) {
    const body = await parseBody(req);
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(body, null, 2));
    send(res, 200, { ok: true });
  }

  return { handleGetSettings, handleSaveSettings };
}
