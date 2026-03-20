import { DatabaseSync as Database } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request workspace DB — isolates concurrent clients on different workspaces.
export const requestDbStore = new AsyncLocalStorage();

// node:sqlite is a built-in Node.js module (available since Node 22.5).
// No native compilation required — SQLite is bundled directly into Node.
export { Database };
