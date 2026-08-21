import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { send, sendError } from '../util/http.js';
import { parseMultipart } from '../util/multipart.js';

const HOME = os.homedir();
const ALLOWED_FILE_DIRS = [HOME, '/tmp'];

export function isPathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function handleServeFile(req, res, query, memoryConfig) {
  const filePath = query.path;
  if (!filePath) return sendError(res, 400, 'Missing path parameter');
  const resolved = (filePath.startsWith('./') || filePath.startsWith('../'))
    ? path.resolve(memoryConfig.workspaceDir, filePath)
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
  const resolved = path.resolve(reqPath.replace(/^~/, HOME));
  if (!isPathWithin(HOME, resolved)) return sendError(res, 403, 'Access denied');
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

export function handleWorkspaceFileRead(req, res, query) {
  const filePath = query.path;
  if (!filePath) return sendError(res, 400, 'Missing path parameter');
  const resolved = path.resolve(filePath.replace(/^~/, HOME));
  if (!isPathWithin(HOME, resolved)) return sendError(res, 403, 'Access denied');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return sendError(res, 404, 'File not found');

  const stat = fs.statSync(resolved);
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
  const resolved = path.resolve(filePath.replace(/^~/, HOME));
  if (!isPathWithin(HOME, resolved)) return sendError(res, 403, 'Can only write to workspace directory');
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
  const resolved = path.resolve(filePath.replace(/^~/, HOME));
  if (!isPathWithin(HOME, resolved)) return sendError(res, 403, 'Access denied');
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
  const resolved = path.resolve(targetDir.replace(/^~/, HOME));
  if (!isPathWithin(HOME, resolved)) return sendError(res, 403, 'Access denied');
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
