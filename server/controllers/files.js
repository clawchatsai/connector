import fs from 'node:fs';
import path from 'node:path';
import { send, sendError, parseBody, uuid } from '../util/http.js';
import { parseMultipart } from '../util/multipart.js';

export class FileController {
  constructor({ getActiveDb, getWorkspaces, uploadsDir, intelligenceDir }) {
    this.getActiveDb = getActiveDb;
    this.getWorkspaces = getWorkspaces;
    this.uploadsDir = uploadsDir;
    this.intelligenceDir = intelligenceDir;
  }

  async upload(req, res, params) {
    if (!this.getActiveDb().prepare('SELECT id FROM threads WHERE id = ?').get(params.id)) return sendError(res, 404, 'Thread not found');
    const files = await parseMultipart(req);
    const dir = path.join(this.uploadsDir, params.id);
    fs.mkdirSync(dir, { recursive: true });
    const savedFiles = [];
    for (const file of files) {
      const fileId = uuid();
      const ext = path.extname(file.filename) || '';
      fs.writeFileSync(path.join(dir, fileId + ext), file.data);
      savedFiles.push({ id: fileId, filename: file.filename, path: `/api/uploads/${params.id}/${fileId}${ext}`, mimeType: file.mimeType, size: file.data.length });
    }
    send(res, 200, { files: savedFiles });
  }

  serveUpload(req, res, params) {
    const base = path.join(this.uploadsDir, params.threadId, params.fileId);
    let resolved = base;
    if (!fs.existsSync(resolved)) {
      try {
        const match = fs.readdirSync(path.join(this.uploadsDir, params.threadId)).find(e => e.startsWith(params.fileId.replace(/\.[^.]+$/, '')));
        if (match) resolved = path.join(this.uploadsDir, params.threadId, match);
      } catch { /* ok */ }
    }
    if (!fs.existsSync(resolved)) return sendError(res, 404, 'File not found');
    const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json' };
    const stat = fs.statSync(resolved);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(resolved).pipe(res);
  }

  _intelligencePath(threadId) {
    return path.join(this.intelligenceDir, this.getWorkspaces().active, `${threadId}.json`);
  }

  getIntelligence(req, res, params) {
    const filePath = this._intelligencePath(params.id);
    if (!fs.existsSync(filePath)) return send(res, 200, { versions: [], currentVersion: -1 });
    try { return send(res, 200, JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch { return send(res, 200, { versions: [], currentVersion: -1 }); }
  }

  async saveIntelligence(req, res, params) {
    const body = await parseBody(req);
    const filePath = this._intelligencePath(params.id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const data = { versions: body.versions || [], currentVersion: body.currentVersion ?? -1, updatedAt: Date.now() };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    send(res, 200, data);
  }
}
