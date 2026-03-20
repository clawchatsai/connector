import fs from 'node:fs';
import path from 'node:path';
import { send, sendError } from '../util/http.js';

export class MemoryController {
  constructor({ memoryProvider, memoryFilesDir, memoryConfig }) {
    this.provider = memoryProvider;
    this.filesDir = memoryFilesDir;
    this.config = memoryConfig;
  }

  async list(req, res, query) {
    const limit = Math.min(parseInt(query.limit) || 20, 100);
    try { send(res, 200, await this.provider.list(limit, query.offset || null)); }
    catch (err) { send(res, 502, { error: `Failed to reach ${this.provider.name}`, detail: err.message }); }
  }

  async search(req, res, query) {
    const q = (query.query || '').toLowerCase().trim();
    if (!q) return send(res, 400, { error: 'Missing query parameter' });
    try { send(res, 200, await this.provider.search(q)); }
    catch (err) { send(res, 502, { error: `Failed to reach ${this.provider.name}`, detail: err.message }); }
  }

  files(req, res, query) {
    const q = (query.query || '').toLowerCase().trim();
    const memories = this._parseFiles();
    const filtered = q ? memories.filter(m => m.data.toLowerCase().includes(q) || m.title.toLowerCase().includes(q)) : memories;
    filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    send(res, 200, { memories: filtered });
  }

  _parseFiles() {
    const memories = [];
    const scanDir = (dir, prefix = '') => {
      let entries;
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = (() => { try { return fs.statSync(fullPath); } catch { return null; } })();
        if (!stat) continue;
        if (stat.isDirectory() && !prefix) { scanDir(fullPath, entry + '/'); continue; }
        if (!entry.endsWith('.md') || !stat.isFile()) continue;
        const content = fs.readFileSync(fullPath, 'utf8');
        const basename = entry.replace(/\.md$/, '');
        const dateMatch = basename.match(/^(\d{4}-\d{2}-\d{2})/);
        if (prefix) {
          memories.push({ id: `file:${prefix + basename}`, source: 'file', file: prefix + basename, title: basename, data: content.trim(), createdAt: stat.mtime.toISOString() });
        } else {
          for (const section of content.split(/^(?=## )/m)) {
            const trimmed = section.trim();
            if (!trimmed) continue;
            const headingMatch = trimmed.match(/^##\s+(.+)/);
            const heading = headingMatch ? headingMatch[1].trim() : null;
            const body = headingMatch ? trimmed.slice(trimmed.indexOf('\n') + 1).trim() : trimmed;
            if (!heading && body.match(/^#\s+/) && body.split('\n').length <= 2) continue;
            const title = heading || basename;
            memories.push({ id: `file:${basename}:${title}`, source: 'file', file: basename, title, data: heading ? `**${title}**\n${body}` : body, createdAt: dateMatch ? `${dateMatch[1]}T00:00:00Z` : stat.mtime.toISOString() });
          }
        }
      }
    };
    scanDir(this.filesDir);
    return memories;
  }

  async update(req, res, params) {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { data } = JSON.parse(Buffer.concat(chunks).toString());
      if (!(data || '').trim()) return send(res, 400, { error: 'Missing data field' });
      send(res, 200, { ok: true, result: await this.provider.update(params.id, data.trim()) });
    } catch (err) { send(res, 502, { error: 'Failed to update memory', detail: err.message }); }
  }

  async delete(req, res, params) {
    try { send(res, 200, { ok: true, result: await this.provider.delete(params.id) }); }
    catch (err) { send(res, 502, { error: `Failed to reach ${this.provider.name}`, detail: err.message }); }
  }

  async status(req, res) {
    const status = await this.provider.status();
    send(res, 200, { provider: this.provider.name, host: this.config.host, port: this.config.port, collection: this.config.collection, backend: status, memoryFilesDir: this.filesDir, memoryFilesDirExists: fs.existsSync(this.filesDir) });
  }
}
