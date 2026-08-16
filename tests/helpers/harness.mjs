// In-process harness for the connector's HTTP API.
//
// `createApp()` is a pure factory: importing server/index.js starts nothing, the
// gateway WebSocket is only dialled by an explicit `connect()` we never call, and
// SQLite is node:sqlite (built in since Node 22.5). So a contract test needs no
// gateway, no compose stack, no native build — just a temp data dir.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Must precede the server import: server/config.js resolves the gateway sessions
// directory from os.homedir() at import time, and the cleanup paths unlink files
// there. See sandbox-home.mjs.
import { sandboxHome } from './sandbox-home.mjs';
import { createApp } from '../../server/index.js';
import { getSessionsDirForAgent } from '../../server/config.js';

// Fail the whole file rather than let a suite run against the real store: a
// redirect that did not take is invisible otherwise, and the tests would report
// green while deleting live transcripts. A repo-root config.js carrying a
// `sessionsDir` field also lands here, since that overrides HOME entirely.
const resolvedSessionsDir = getSessionsDirForAgent('main');
if (!resolvedSessionsDir.startsWith(sandboxHome)) {
  throw new Error(
    `Refusing to run: the sessions directory resolved to ${resolvedSessionsDir}, outside the ` +
    `sandbox at ${sandboxHome}. Tests would mutate a real ~/.openclaw session store.`,
  );
}

/**
 * Boot the API on an ephemeral port backed by throwaway directories.
 * Returns the server plus an `api()` client and a `close()` teardown.
 */
export async function startTestServer(config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-test-data-'));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-test-uploads-'));

  const app = createApp({
    dataDir,
    uploadsDir,
    authToken: '',
    // The default (qdrant) provider fires a live fetch at boot; the pg provider's
    // init is a no-op and its pool is lazy, so tests stay offline.
    memoryEnv: { provider: 'postgres' },
    ...config,
  });

  const server = http.createServer(app.handleRequest);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  /**
   * Issue a request and always resolve to `{ status, headers, body }`.
   * JSON bodies are parsed; anything else comes back as text, so a route that
   * returns HTML or an error page is asserted on rather than throwing.
   */
  async function api(method, urlPath, { body, headers = {}, raw } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      if (raw) {
        init.body = body;
      } else {
        init.headers['content-type'] = init.headers['content-type'] || 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    const res = await fetch(origin + urlPath, init);
    const text = await res.text();
    let parsed = text;
    if (text) {
      try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
    }
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: parsed,
    };
  }

  async function close() {
    app.shutdown();
    await new Promise(resolve => server.close(resolve));
    for (const dir of [dataDir, uploadsDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return { app, server, origin, api, dataDir, uploadsDir, close };
}

/** Create a thread and return its id — the setup step most message specs need. */
export async function createThread(api, fields = {}) {
  const res = await api('POST', '/api/threads', { body: { title: 'Test thread', ...fields } });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`thread setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id ?? res.body.thread?.id;
}
