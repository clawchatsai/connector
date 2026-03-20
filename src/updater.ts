/**
 * Auto-update checker for the @clawchatsai/connector plugin.
 *
 * Checks the npm registry for newer versions and can trigger
 * an in-place update via the OpenClaw plugin CLI.
 */

import { execFile } from 'node:child_process';
import { PLUGIN_VERSION } from './index.js';

export interface UpdateInfo {
  current: string;
  latest: string;
}

/**
 * Compare two semver strings. Returns true if `a` is greater than `b`.
 * Handles major.minor.patch only — no pre-release suffixes.
 */
function semverGt(a: string, b: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };

  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);

  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

/**
 * Check npm registry for updates.
 * Returns UpdateInfo if a newer version is available, null otherwise.
 * Silently returns null on any network or parse error.
 */
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@clawchatsai%2Fconnector/latest');
    if (!res.ok) return null;

    const data = await res.json() as { version?: string };
    const latest = data.version;

    if (typeof latest !== 'string') return null;
    if (!semverGt(latest, PLUGIN_VERSION)) return null;

    return { current: PLUGIN_VERSION, latest };
  } catch {
    return null;
  }
}

/**
 * Run the OpenClaw plugin update command.
 * Throws an Error if the command exits with a non-zero code or times out.
 */
export async function performUpdate(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'openclaw',
      ['plugins', 'update', '@clawchatsai/connector'],
      { timeout: 120_000 },
      (error) => {
        if (error) {
          reject(new Error(`Plugin update failed: ${error.message}`));
        } else {
          resolve();
        }
      },
    );

    child; // reference kept to satisfy linter — callback handles lifecycle
  });
}
