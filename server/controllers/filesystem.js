import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { send, sendError } from '../util/http.js';
import { parseMultipart } from '../util/multipart.js';

const HOME = os.homedir();
const ALLOWED_FILE_DIRS = [HOME, '/tmp'];

// Resolves a `~`-relative or absolute path; returns null unless it is HOME or inside it
// (a bare prefix check would also admit siblings such as /home/user2).
function resolveInHome(p) {
  const resolved = path.resolve(p.replace(/^~/, HOME));
  return resolved === HOME || resolved.startsWith(HOME + path.sep) ? resolved : null;
}

export function handleServeFile(req, res, query, workspaceDir) {
  const filePath = query.path;
  if (!filePath) return sendError(res, 400, 'Missing path parameter');
  const resolved = (filePath.startsWith('./') || filePath.startsWith('../'))
    ? path.resolve(workspaceDir, filePath)
    : path.resolve(filePath);
  if (!ALLOWED_FILE_DIRS.some(dir => resolved.startsWith(dir + '/') || resolved === dir)) return sendError(res, 403, 'Access denied: path not in allowed directories');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return sendError(res, 404, 'File not found');

  const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json',
    '.md': 'text/markdown', '.csv': 'text/csv', '.xml': 'text/xml',
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.py': 'text/x-python', '.sh': 'text/x-shellscript',
    '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/toml',
    '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
  };
  const stat = fs.statSync(resolved);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(resolved).pipe(res);
}

export function handleWorkspaceList(req, res, query) {
  const reqPath = query.path || '~/.openclaw/workspace';
  const depth = parseInt(query.depth || '2', 10);
  const showHidden = query.hidden === '1' || query.hidden === 'true';
  const resolved = resolveInHome(reqPath);
  if (!resolved) return sendError(res, 403, 'Access denied');
  if (!fs.existsSync(resolved)) return sendError(res, 404, 'Path not found');

  const files = [{ path: resolved + '/', type: 'dir', name: path.basename(resolved), size: 0 }];
  const walk = (dir, d) => {
    if (d > depth) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.openclaw' && !showHidden) continue;
        if (entry.name === 'node_modules') continue;
        const fullPath = path.join(dir, entry.name);
        const isDir = entry.isDirectory();
        files.push({ path: fullPath + (isDir ? '/' : ''), type: isDir ? 'dir' : 'file', name: entry.name, size: isDir ? 0 : (() => { try { return fs.statSync(fullPath).size; } catch { return 0; } })() });
        if (isDir) walk(fullPath, d + 1);
      }
    } catch { /* permission denied */ }
  };
  walk(resolved, 1);
  send(res, 200, { files, cwd: resolved });
}

const MAX_HINTS = 40;
const MAX_SEARCH_DIRS = 400;

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

function addMatch(matches, candidate) {
  if (!isFile(candidate)) return;
  try { matches.set(fs.realpathSync(candidate), candidate); } catch { /* vanished */ }
}

// True when the file sits in a git main checkout (`.git` is a folder), false in a linked
// worktree (`.git` is a file) or outside git.
function inMainCheckout(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    try { return fs.statSync(path.join(dir, '.git')).isDirectory(); } catch { /* keep walking */ }
    if (dir === path.dirname(dir)) return false;
  }
}

// One distinct file wins; among several, a single one in a git main checkout wins (other chats'
// worktrees carry copies of the same file). Anything else is ambiguous.
function pickMatch(matches) {
  const found = [...matches.values()];
  if (found.length <= 1) return found[0] ?? null;
  const main = found.filter(inMainCheckout);
  return main.length === 1 ? main[0] : null;
}

// Directory children worth searching: no dot-folders, no node_modules.
function childDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => path.join(dir, e.name));
  } catch { return []; }
}

// The hint's folder no longer exists (typically a worktree removed after its branch merged). Search
// two levels below the parent of its nearest surviving ancestor, kept inside HOME, for the file.
function searchAroundGoneHint(hint, p, matches, searched) {
  let survivor = path.dirname(hint);
  while (!exists(survivor) && survivor !== path.dirname(survivor)) survivor = path.dirname(survivor);
  const insideHome = d => d.startsWith(HOME + path.sep);
  const base = insideHome(path.dirname(survivor)) ? path.dirname(survivor) : insideHome(survivor) ? survivor : null;
  if (!base || searched.has(base)) return;
  searched.add(base);
  let budget = MAX_SEARCH_DIRS;
  for (const child of childDirs(base)) {
    if (--budget < 0) return;
    addMatch(matches, path.join(child, p));
    for (const grandchild of childDirs(child)) {
      if (--budget < 0) return;
      addMatch(matches, path.join(grandchild, p));
    }
  }
}

/**
 * Where a file reference from chat points (specs/file-link-check.md in the clawchats repo).
 * `~` is home and absolute paths stand as written. A relative path tries the session root, then
 * the agent workspace. Failing those it tries every ancestor of each hint (absolute paths from
 * the same turn's tool calls, e.g. a `cd` target); if none matches, hints whose folder is gone get
 * a bounded search near where they were. Ties go to a git main checkout (pickMatch).
 * Returns the absolute path, or null.
 */
export function resolveReadPath(filePath, { roots = [], hints = [] } = {}) {
  const p = filePath.replace(/^~(?=\/|$)/, HOME);
  if (path.isAbsolute(p)) return isFile(p) ? path.resolve(p) : null;
  for (const root of roots) {
    if (!root) continue;
    const candidate = path.resolve(root, p);
    if (isFile(candidate)) return candidate;
  }
  const absHints = [...new Set(hints.slice(0, MAX_HINTS)
    .map(h => h.replace(/^~(?=\/|$)/, HOME))
    .filter(h => path.isAbsolute(h))
    .map(h => path.resolve(h)))];
  const matches = new Map(); // real path -> path as found
  const tried = new Set();
  for (const hint of absHints) {
    for (let dir = hint; ; dir = path.dirname(dir)) {
      if (!tried.has(dir)) {
        tried.add(dir);
        addMatch(matches, path.resolve(dir, p));
      }
      if (dir === path.dirname(dir)) break;
    }
  }
  if (matches.size) return pickMatch(matches);
  const searched = new Set();
  for (const hint of absHints) {
    if (!exists(hint)) searchAroundGoneHint(hint, p, matches, searched);
  }
  return pickMatch(matches);
}

// Reads any file the gateway user can read (file links in chat open any path, as the agent
// wrote it); resolution in resolveReadPath. `stat=1` answers {path, size} instead of the
// content, so a click can check a link before opening the pane. `hints` is newline-separated.
// Writes and deletes stay limited to HOME.
export function handleWorkspaceFileRead(req, res, query, workspaceDir, sessionRoot = null) {
  const filePath = query.path;
  if (!filePath) return sendError(res, 400, 'Missing path parameter');
  const hints = query.hints ? query.hints.split('\n').filter(Boolean) : [];
  const resolved = resolveReadPath(filePath, { roots: [sessionRoot, workspaceDir], hints });
  if (!resolved) return sendError(res, 404, 'File not found');

  const stat = fs.statSync(resolved);
  if (query.stat) return send(res, 200, { path: resolved, size: stat.size });
  const ext = path.extname(resolved).toLowerCase().slice(1);
  const binaryMime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'video/webm' };
  const mime = binaryMime[ext];

  if (mime) {
    if (stat.size > 20 * 1024 * 1024) return sendError(res, 413, 'File too large (max 20MB)');
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=60' });
    res.end(fs.readFileSync(resolved));
  } else {
    if (stat.size > 1024 * 1024) return sendError(res, 413, 'File too large (max 1MB)');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(fs.readFileSync(resolved, 'utf8'));
  }
}

export async function handleWorkspaceFileWrite(req, res, query) {
  const filePath = query.path;
  if (!filePath) return sendError(res, 400, 'Missing path parameter');
  const resolved = resolveInHome(filePath);
  if (!resolved) return sendError(res, 403, 'Can only write to workspace directory');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, Buffer.concat(chunks).toString('utf8'), 'utf8');
  send(res, 200, { ok: true });
}

export function handleWorkspaceFileDelete(req, res, query) {
  const filePath = query.path;
  if (!filePath) return sendError(res, 400, 'Missing path parameter');
  const resolved = resolveInHome(filePath);
  if (!resolved) return sendError(res, 403, 'Access denied');
  if (!fs.existsSync(resolved)) return sendError(res, 404, 'Path not found');
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) { fs.rmSync(resolved, { recursive: true, force: true }); send(res, 200, { ok: true, type: 'dir' }); }
    else { fs.unlinkSync(resolved); send(res, 200, { ok: true, type: 'file' }); }
  } catch (err) { sendError(res, 500, 'Delete failed: ' + err.message); }
}

export async function handleWorkspaceUpload(req, res, query) {
  const targetDir = query.path;
  if (!targetDir) return sendError(res, 400, 'Missing path parameter');
  const resolved = resolveInHome(targetDir);
  if (!resolved) return sendError(res, 403, 'Access denied');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return sendError(res, 404, 'Target directory not found');
  if (!(req.headers['content-type'] || '').includes('multipart/form-data')) return sendError(res, 400, 'Expected multipart/form-data');

  let files;
  try { files = await parseMultipart(req); }
  catch (err) { return sendError(res, 400, 'Invalid multipart data: ' + err.message); }

  const uploaded = [];
  for (const { filename, data } of files) {
    if (!filename || !data.length) continue;
    const safeName = path.basename(filename);
    let finalPath = path.join(resolved, safeName);
    let counter = 1;
    while (fs.existsSync(finalPath)) {
      const ext = path.extname(safeName);
      finalPath = path.join(resolved, `${path.basename(safeName, ext)} (${counter++})${ext}`);
    }
    fs.writeFileSync(finalPath, data);
    uploaded.push({ name: path.basename(finalPath), size: data.length });
  }
  send(res, 200, { ok: true, uploaded });
}

// Creates one empty file or folder named `name` inside the directory `path`.
export function handleWorkspaceCreate(req, res, query) {
  const { path: parentPath, name, type } = query;
  if (!parentPath || !name) return sendError(res, 400, 'Missing path or name parameter');
  if (type !== 'file' && type !== 'dir') return sendError(res, 400, 'type must be file or dir');
  if (name === '.' || name === '..' || /[/\\\0]/.test(name) || name.trim() !== name) return sendError(res, 400, 'Invalid name');
  const parent = resolveInHome(parentPath);
  if (!parent) return sendError(res, 403, 'Access denied');
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return sendError(res, 404, 'Target directory not found');
  const target = path.join(parent, name);
  try {
    if (type === 'dir') fs.mkdirSync(target);
    else fs.writeFileSync(target, '', { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return sendError(res, 409, `"${name}" already exists`);
    return sendError(res, 500, 'Create failed: ' + err.message);
  }
  send(res, 200, { ok: true, path: target + (type === 'dir' ? '/' : ''), type });
}
