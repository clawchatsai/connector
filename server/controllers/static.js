import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
};

const STATIC_MAP = {
  '/':            'index.html',
  '/index.html':  'index.html',
  '/app.js':      'app.js',
  '/style.css':   'style.css',
  '/error-handler.js': 'error-handler.js',
  '/manifest.json': 'manifest.json',
  '/favicon.ico': 'favicon.ico',
};

/**
 * The real path of `rel` inside rootDir, or null if it is missing or would escape rootDir
 * (`..`, an absolute path, a NUL byte, or a symlink pointing outside).
 */
export function resolveStaticPath(rootDir, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  try {
    const root = fs.realpathSync(path.resolve(rootDir));
    const real = fs.realpathSync(path.resolve(root, rel));
    return real.startsWith(root + path.sep) ? real : null;
  } catch {
    return null; // missing
  }
}

/**
 * Serve static files from pluginDir.
 * Returns true if the request was handled, false if it should fall through.
 * Keeps fs.createReadStream out of the HTTP router (server/index.js).
 */
export function handleStatic(req, res, pluginDir) {
  const urlPath = (req.url || '/').split('?')[0];
  const fileName = STATIC_MAP[urlPath];
  const isAllowed =
    fileName ||
    urlPath.startsWith('/icons/') ||
    urlPath.startsWith('/lib/') ||
    urlPath.startsWith('/frontend/') ||
    urlPath.startsWith('/emoji/') ||
    urlPath === '/config.js';

  if (!isAllowed) return false;

  const staticPath = resolveStaticPath(pluginDir, fileName || urlPath.slice(1));
  if (!staticPath) return false;
  const stat = fs.statSync(staticPath);
  if (!stat.isFile()) return false;

  const ext  = path.extname(staticPath).toLowerCase();
  res.writeHead(200, {
    'Content-Type':   MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control':  ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(staticPath).pipe(res);
  return true;
}
