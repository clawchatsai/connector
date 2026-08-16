// Contract tests for the auth boundary, HTTP dispatch, and CORS behaviour of
// server/index.js. See checkAuth() (~line 108) and the single enforcement
// gate (~line 162): everything registered in route() ABOVE that gate is
// reachable without auth, even when auth is enabled. That carve-out list is
// a security boundary, so it gets pinned precisely here.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from '../helpers/harness.mjs';

const TOKEN = 'secret-token';

describe('auth enabled: protected routes reject bad credentials', () => {
  let ctx;
  before(async () => { ctx = await startTestServer({ authToken: TOKEN }); });
  after(async () => { await ctx.close(); });

  test('no Authorization header -> 401 with an error message', async () => {
    const res = await ctx.api('GET', '/api/health', {});
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Missing or invalid Authorization header/);
  });

  test('malformed header: wrong scheme (Basic) -> 401', async () => {
    const res = await ctx.api('GET', '/api/health', { headers: { Authorization: 'Basic xyz' } });
    assert.equal(res.status, 401);
  });

  test('malformed header: bare token, no "Bearer " prefix -> 401', async () => {
    const res = await ctx.api('GET', '/api/health', { headers: { Authorization: TOKEN } });
    assert.equal(res.status, 401);
  });

  test('malformed header: "Bearer" alone (no token, no trailing space) -> 401', async () => {
    const res = await ctx.api('GET', '/api/health', { headers: { Authorization: 'Bearer' } });
    assert.equal(res.status, 401);
  });

  test('malformed header: "Bearer " with empty token -> 401', async () => {
    const res = await ctx.api('GET', '/api/health', { headers: { Authorization: 'Bearer ' } });
    assert.equal(res.status, 401);
  });

  test('wrong token -> 401 "Invalid auth token"', async () => {
    const res = await ctx.api('GET', '/api/health', { headers: { Authorization: 'Bearer nope' } });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid auth token/);
  });

  test('correct "Bearer <token>" -> 200', async () => {
    const res = await ctx.api('GET', '/api/health', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('representative protected route right below the gate (POST /api/emoji/add) is blocked without auth', async () => {
    const res = await ctx.api('POST', '/api/emoji/add', { body: { url: 'https://example.com/x.png', name: 'x' } });
    assert.equal(res.status, 401);
  });

  test('routes that should be protected are not accidentally public', async () => {
    for (const [method, urlPath] of [
      ['GET', '/api/threads'],
      ['GET', '/api/workspaces'],
      ['GET', '/api/settings'],
      ['GET', '/api/export'],
    ]) {
      const res = await ctx.api(method, urlPath, {});
      assert.equal(res.status, 401, `${method} ${urlPath} should require auth, got ${res.status}`);
    }
  });
});

describe('auth enabled: public carve-outs registered above the checkAuth gate', () => {
  let ctx;
  // A real static asset is created directly in the plugin dir (parent of
  // server/) for the duration of this suite only, since this connector
  // checkout ships no frontend assets to exercise handleStatic() against.
  // It is removed in `after`, leaving no trace on disk.
  const pluginDir = path.resolve(import.meta.dirname, '../..');
  const staticAssetPath = path.join(pluginDir, 'favicon.ico');
  const staticAssetPreexisted = fs.existsSync(staticAssetPath);

  before(async () => {
    ctx = await startTestServer({ authToken: TOKEN });
    if (!staticAssetPreexisted) fs.writeFileSync(staticAssetPath, Buffer.from([0x00, 0x01]));
  });
  after(async () => {
    if (!staticAssetPreexisted) { try { fs.rmSync(staticAssetPath); } catch { /* already gone */ } }
    await ctx.close();
  });

  test('OPTIONS short-circuits before auth, even for a protected path', async () => {
    const res = await ctx.api('OPTIONS', '/api/threads', {});
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });

  test('static file serving (handleStatic) is public', async () => {
    const res = await ctx.api('GET', '/favicon.ico', {});
    assert.equal(res.status, 200);
  });

  test('GET /api/uploads/:threadId/:fileId is public', async () => {
    const threadId = 'thread-abc';
    fs.mkdirSync(path.join(ctx.uploadsDir, threadId), { recursive: true });
    fs.writeFileSync(path.join(ctx.uploadsDir, threadId, 'file.txt'), 'hello');
    const res = await ctx.api('GET', `/api/uploads/${threadId}/file.txt`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body, 'hello');
  });

  test('GET /api/emoji is public', async () => {
    const res = await ctx.api('GET', '/api/emoji', {});
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  test('GET /api/emoji/search is public (reached before the auth gate)', async () => {
    // No `?q=` avoids the outbound network call in the handler while still
    // proving the route was reached without a 401 from checkAuth.
    const res = await ctx.api('GET', '/api/emoji/search', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Missing \?q=/);
  });
});

describe('auth disabled (shipped production default): everything is reachable with no header', () => {
  let ctx;
  before(async () => { ctx = await startTestServer(); }); // authToken: '' by default
  after(async () => { await ctx.close(); });

  test('protected-looking routes respond without any Authorization header', async () => {
    for (const [method, urlPath] of [
      ['GET', '/api/threads'],
      ['GET', '/api/workspaces'],
      ['GET', '/api/settings'],
      ['GET', '/api/export'],
      ['GET', '/api/health'],
      ['POST', '/api/emoji/add'],
    ]) {
      const res = await ctx.api(method, urlPath, method === 'POST' ? { body: {} } : {});
      assert.notEqual(res.status, 401, `${method} ${urlPath} unexpectedly required auth`);
    }
  });

  test('GET /api/health -> 200 with no header at all', async () => {
    const res = await ctx.api('GET', '/api/health', {});
    assert.equal(res.status, 200);
  });
});

describe('dispatch and CORS', () => {
  let ctx;
  before(async () => { ctx = await startTestServer(); });
  after(async () => { await ctx.close(); });

  test('OPTIONS on an API path -> 204 with CORS headers', async () => {
    const res = await ctx.api('OPTIONS', '/api/threads', {});
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(res.headers['access-control-allow-methods'], /GET/);
    assert.match(res.headers['access-control-allow-headers'], /Authorization/);
  });

  test('unknown /api/... path -> 404, not 500 or a hang', async () => {
    const res = await ctx.api('GET', '/api/this-route-does-not-exist', {});
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Not found/);
  });

  test('known path with wrong method -> 404, not a crash', async () => {
    const res = await ctx.api('PUT', '/api/health', {});
    assert.equal(res.status, 404);
  });

  test('malformed JSON body on a POST does not hang and does not crash the server', async () => {
    const res = await ctx.api('POST', '/api/threads', {
      raw: true,
      body: '{not valid json',
      headers: { 'content-type': 'application/json' },
    });
    // parseBody() (server/util/http.js) rejects with `Invalid JSON` on bad
    // input; the route's catch-all (server/index.js ~line 279) does not
    // special-case that rejection, so it falls into the generic 500 branch
    // rather than a 400. Asserted here as the current, deterministic
    // behaviour — not a hang, not an unhandled crash. See bug note below.
    assert.equal(res.status, 500);
    assert.match(res.body.error, /Invalid JSON/);

    // The server must still be alive and serving other requests afterwards.
    const followUp = await ctx.api('GET', '/api/health', {});
    assert.equal(followUp.status, 200);
  });

  test('JSON responses set Content-Type: application/json', async () => {
    const res = await ctx.api('GET', '/api/health', {});
    assert.match(res.headers['content-type'], /application\/json/);
  });
});
