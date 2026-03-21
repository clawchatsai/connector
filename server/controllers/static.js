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

  const staticPath = path.join(pluginDir, fileName || urlPath.slice(1));
  if (!fs.existsSync(staticPath) || !fs.statSync(staticPath).isFile()) return false;

  const ext  = path.extname(staticPath).toLowerCase();
  const stat = fs.statSync(staticPath);
  res.writeHead(200, {
    'Content-Type':   MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control':  ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(staticPath).pipe(res);
  return true;
}
