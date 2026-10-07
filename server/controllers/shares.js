// Share links (ClawChats extra), bring-your-own storage. The browser encrypts an artifact and sends only the
// ciphertext envelope here; the connector wraps it in a self-contained viewer page (share/viewer-page.js) and
// uploads that one HTML file to the user's own bucket (Cloudflare R2 today, any S3-compatible store later).
// The decryption key stays in the link fragment, so the storage provider can't read a share, and no
// ClawChats server is involved. Spec: clawchats repo, specs/sharing-and-artifacts.md.
//
// <dataDir>/share-storage.json  derived S3 credentials + public URL (0600; never sent to the browser)
// <dataDir>/shares.json         [{id, url, title, type, mode, createdAt, expiresAt, source?}]  (no keys)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { send, sendError, parseBody } from '../util/http.js';
import { createS3Client } from '../share/s3.js';
import { setupR2 } from '../share/r2-setup.js';
import { buildSharePage } from '../share/viewer-page.js';

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_TITLE = 200;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(['html', 'svg', 'markdown', 'mermaid', 'csv', 'code', 'chat']);
const SWEEP_MS = 60 * 60 * 1000;
const objectKey = id => `shares/${id}.html`;

// Where a share came from, so ClawChats can list a chat's or a file's links next to it:
// {kind: 'chat'|'artifact'|'file', chatId?, name?, path?}. Unknown kinds and fields are dropped.
const SOURCE_KINDS = new Set(['chat', 'artifact', 'file']);
export function cleanSource(src) {
  if (!src || typeof src !== 'object' || !SOURCE_KINDS.has(src.kind)) return undefined;
  const out = { kind: src.kind };
  for (const k of ['chatId', 'name', 'path']) if (typeof src[k] === 'string' && src[k]) out[k] = src[k].slice(0, 500);
  return out;
}

export function validEnvelope(e) {
  const b64u = s => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s);
  if (!e || typeof e !== 'object' || e.v !== 1 || e.alg !== 'A256GCM' || !b64u(e.iv) || !b64u(e.ct)) return false;
  if (e.kdf !== undefined) {
    const k = e.kdf;
    if (!k || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || !Number.isInteger(k.iter) || k.iter < 100000 || !b64u(k.salt)) return false;
  }
  return Object.keys(e).every(k => ['v', 'alg', 'iv', 'ct', 'kdf'].includes(k));
}

const newId = () => crypto.randomBytes(16).toString('base64url');

export function createShareHandlers({ dataDir, fetchImpl = globalThis.fetch, setup = setupR2, s3Factory = createS3Client, sweepTimer = true }) {
  const storageFile = path.join(dataDir, 'share-storage.json');
  const indexFile = path.join(dataDir, 'shares.json');

  const writePrivate = (file, data) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const readStorage = () => { try { return JSON.parse(fs.readFileSync(storageFile, 'utf8')); } catch { return null; } };
  const readIndex = () => { try { const v = JSON.parse(fs.readFileSync(indexFile, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
  const isExpired = r => !!r.expiresAt && Date.parse(r.expiresAt) <= Date.now();
  const client = cfg => s3Factory(cfg, fetchImpl);
  const publicInfo = cfg => cfg && { provider: cfg.provider, bucket: cfg.bucket, publicBaseUrl: cfg.publicBaseUrl };

  // Delete expired shares from storage (the box runs 24/7, so the connector is the expiry clock).
  async function sweep() {
    const cfg = readStorage();
    const rows = readIndex();
    const expired = rows.filter(isExpired);
    if (!cfg || !expired.length) return;
    const s3 = client(cfg);
    const gone = new Set();
    for (const r of expired) {
      try { const { status } = await s3.delete(objectKey(r.id)); if (status < 300 || status === 404) gone.add(r.id); } catch {}
    }
    if (gone.size) writePrivate(indexFile, readIndex().filter(r => !gone.has(r.id)));
  }
  if (sweepTimer) setInterval(() => sweep().catch(() => {}), SWEEP_MS).unref();

  // GET /api/extras/shares → {configured, storage, shares}
  async function handleList(req, res) {
    await sweep().catch(() => {});
    const cfg = readStorage();
    return send(res, 200, {
      configured: !!cfg,
      storage: publicInfo(cfg),
      shares: readIndex().filter(r => !isExpired(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    });
  }

  // POST /api/extras/shares/storage {token} → set up the user's R2 bucket, prove it works, save credentials
  async function handleSetup(req, res) {
    const { token } = await parseBody(req);
    let cfg;
    try { cfg = await setup(token, { fetchImpl }); } catch (err) { return sendError(res, err.code ? 400 : 502, err.message); }
    const s3 = client(cfg);
    const probe = `shares/.clawchats-setup-${newId()}.txt`;
    const put = await s3.put(probe, 'ClawChats share storage test', { contentType: 'text/plain; charset=utf-8' });
    await s3.delete(probe).catch(() => {});
    if (put.status !== 200) return sendError(res, 502, `Your bucket refused a test upload (HTTP ${put.status}). Check the token has Admin Read & Write.`);
    writePrivate(storageFile, cfg);
    return send(res, 200, { storage: publicInfo(cfg) });
  }

  // DELETE /api/extras/shares/storage → forget the credentials (existing links keep working until deleted)
  function handleForgetStorage(req, res) {
    fs.rmSync(storageFile, { force: true });
    return send(res, 200, { ok: true });
  }

  // POST /api/extras/shares {envelope, expiresAt?, title, type, source?} → {share}
  async function handleCreate(req, res) {
    const cfg = readStorage();
    if (!cfg) return sendError(res, 409, 'Connect your Cloudflare storage first');
    const { envelope, expiresAt, title, type, source } = await parseBody(req);
    if (!validEnvelope(envelope)) return sendError(res, 400, 'Missing or malformed encrypted envelope');
    if (!TYPES.has(type)) return sendError(res, 400, 'Unsupported artifact type');
    let expires = null;
    if (expiresAt != null) {
      const t = Date.parse(expiresAt);
      if (!Number.isFinite(t) || t <= Date.now()) return sendError(res, 400, 'Expiry must be in the future');
      expires = new Date(t).toISOString();
    }
    const page = buildSharePage(envelope);
    if (Buffer.byteLength(page) > MAX_PAGE_BYTES) return sendError(res, 413, 'This artifact is too big to share (5 MB max)');

    const id = newId();
    const put = await client(cfg).put(objectKey(id), page, { contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' });
    if (put.status !== 200) return sendError(res, 502, `Your storage refused the upload (HTTP ${put.status})`);

    const share = {
      id,
      url: `${cfg.publicBaseUrl}/${objectKey(id)}`,
      title: String(title || 'Shared artifact').slice(0, MAX_TITLE),
      type,
      mode: envelope.kdf ? 'password' : 'link',
      createdAt: new Date().toISOString(),
      expiresAt: expires,
      ...(cleanSource(source) ? { source: cleanSource(source) } : {}),
    };
    writePrivate(indexFile, [share, ...readIndex()]);
    sweep().catch(() => {});
    return send(res, 201, { share });
  }

  // DELETE /api/extras/shares/:id → delete the page from the bucket, then from the index
  async function handleRevoke(req, res, id) {
    if (!ID_RE.test(id)) return sendError(res, 400, 'Bad share id');
    const cfg = readStorage();
    if (!cfg) return sendError(res, 409, 'Connect your Cloudflare storage first');
    const { status } = await client(cfg).delete(objectKey(id));
    if (status >= 300 && status !== 404) return sendError(res, 502, `Your storage refused the delete (HTTP ${status})`);
    writePrivate(indexFile, readIndex().filter(r => r.id !== id));
    return send(res, 200, { ok: true });
  }

  return { handleList, handleSetup, handleForgetStorage, handleCreate, handleRevoke, sweep };
}
