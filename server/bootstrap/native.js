import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

// Per-request workspace DB — isolates concurrent clients on different workspaces.
export const requestDbStore = new AsyncLocalStorage();

// better-sqlite3 is a native binary compiled for a specific Node.js ABI.
// Auto-rebuild if the installed binary doesn't match the running Node version.
function loadDatabase() {
  const isAbiMismatch = e => e.message && (
    e.message.includes('did not self-register') ||
    e.message.includes('NODE_MODULE_VERSION') ||
    e.message.includes('was compiled against a different Node.js version')
  );
  try {
    return _require('better-sqlite3');
  } catch (e) {
    if (!isAbiMismatch(e)) throw e;
    console.error('[ClawChats] better-sqlite3 binary is incompatible with your Node.js version. Attempting auto-rebuild...');
    try {
      execSync('npm rebuild better-sqlite3', { cwd: __dirname, stdio: 'inherit' });
      const db = _require('better-sqlite3');
      console.log('[ClawChats] Auto-rebuild succeeded — continuing startup.');
      return db;
    } catch (rebuildErr) {
      console.error('[ClawChats] Auto-rebuild failed. Build tools may be missing.');
      console.error(`[ClawChats]   cd ${__dirname} && npm rebuild better-sqlite3`);
      console.error('[ClawChats]   Linux:  sudo apt install build-essential python3');
      console.error('[ClawChats]   macOS:  xcode-select --install');
      process.exit(1);
    }
  }
}

export const Database = loadDatabase();
