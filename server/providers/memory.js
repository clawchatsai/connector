import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Discover memory backend configuration from env vars and OpenClaw config
export function discoverMemoryConfig() {
  const defaults = { provider: 'qdrant', host: 'localhost', port: 6333, collection: null };
  let oc = null;
  for (const cfgPath of [path.join(os.homedir(), '.openclaw', 'openclaw.json'), '/etc/openclaw/openclaw.json']) {
    try { oc = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); break; } catch { /* try next */ }
  }

  let cfg = { ...defaults };
  if (oc) {
    const vs = oc.plugins?.slots?.memory ? oc.plugins?.entries?.[oc.plugins.slots.memory]?.config?.oss?.vectorStore : null;
    if (vs) {
      if (vs.provider) cfg.provider = vs.provider;
      if (vs.config?.host) cfg.host = vs.config.host;
      if (vs.config?.port) cfg.port = vs.config.port;
      if (vs.config?.collectionName) cfg.collection = vs.config.collectionName;
      if (vs.config?.user) cfg.pgUser = vs.config.user;
      if (vs.config?.password) cfg.pgPassword = vs.config.password;
      if (vs.config?.dbname) cfg.pgDbName = vs.config.dbname;
    }
    const wsDir = oc.agents?.defaults?.workspace;
    if (wsDir) cfg.workspaceDir = wsDir;
  }

  if (process.env.MEMORY_PROVIDER) cfg.provider = process.env.MEMORY_PROVIDER;
  if (process.env.MEMORY_HOST || process.env.QDRANT_HOST) cfg.host = process.env.MEMORY_HOST || process.env.QDRANT_HOST;
  if (process.env.MEMORY_PORT || process.env.QDRANT_PORT) cfg.port = parseInt(process.env.MEMORY_PORT || process.env.QDRANT_PORT, 10);
  if (process.env.MEMORY_COLLECTION || process.env.QDRANT_COLLECTION) cfg.collection = process.env.MEMORY_COLLECTION || process.env.QDRANT_COLLECTION;
  if (process.env.MEMORY_PG_URL) cfg.pgUrl = process.env.MEMORY_PG_URL;
  if (process.env.QDRANT_URL && !process.env.MEMORY_HOST) {
    try { const u = new URL(process.env.QDRANT_URL); cfg.host = u.hostname; if (u.port) cfg.port = parseInt(u.port, 10); } catch { /* ignore */ }
  }
  if (!cfg.workspaceDir) cfg.workspaceDir = path.join(os.homedir(), '.openclaw', 'workspace');
  return cfg;
}

export async function autoDetectQdrantCollection(config) {
  if (config.collection) return config.collection;
  try {
    const r = await fetch(`http://${config.host}:${config.port}/collections`, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    const found = (data.result?.collections || []).map(c => c.name).find(n => !n.includes('migration'));
    if (found) { console.log(`Memory: auto-detected Qdrant collection "${found}"`); return found; }
  } catch { /* fall through */ }
  console.log('Memory: Qdrant unreachable or no collections, falling back to "memories"');
  return 'memories';
}

function createQdrantProvider(config) {
  const baseUrl = `http://${config.host}:${config.port}`;
  let collection = config.collection;
  return {
    name: 'qdrant',
    config,
    async init() { collection = await autoDetectQdrantCollection(config); config.collection = collection; },
    async list(limit, offset) {
      const body = { limit, with_payload: true, with_vector: false };
      if (offset) body.offset = offset;
      const r = await fetch(`${baseUrl}/collections/${collection}/points/scroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json();
      return { memories: (data.result?.points || []).map(p => ({ id: p.id, ...p.payload })), next_offset: data.result?.next_page_offset || null };
    },
    async search(query) {
      const q = query.toLowerCase();
      const matches = [];
      let offset = null;
      do {
        const body = { limit: 100, with_payload: true, with_vector: false };
        if (offset) body.offset = offset;
        const r = await fetch(`${baseUrl}/collections/${collection}/points/scroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await r.json();
        for (const p of (data.result?.points || [])) { if ((p.payload?.data || '').toLowerCase().includes(q)) matches.push({ id: p.id, ...p.payload }); }
        offset = data.result?.next_page_offset || null;
      } while (offset);
      return { memories: matches, next_offset: null };
    },
    async update(id, newData) {
      const r = await fetch(`${baseUrl}/collections/${collection}/points/payload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: [id], payload: { data: newData } }) });
      const data = await r.json();
      if (data.status?.error) throw new Error(data.status.error);
      return data.result;
    },
    async delete(id) {
      const r = await fetch(`${baseUrl}/collections/${collection}/points/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: [id] }) });
      return (await r.json()).result;
    },
    async status() {
      try {
        const r = await fetch(`${baseUrl}/collections/${collection}`, { signal: AbortSignal.timeout(3000) });
        const data = await r.json();
        return { reachable: true, pointsCount: data.result?.points_count ?? null };
      } catch { return { reachable: false }; }
    },
  };
}

function createPgProvider(config) {
  let _pool = null;
  const table = config.collection || 'memories';
  async function getPool() {
    if (_pool) return _pool;
    let pg;
    try { pg = await import('pg'); } catch { throw new Error('pg package not installed. Run: npm install pg'); }
    const Pool = pg.default?.Pool || pg.Pool;
    _pool = config.pgUrl ? new Pool({ connectionString: config.pgUrl }) : new Pool({ host: config.host, port: config.port || 5432, user: config.pgUser || 'mem0', password: config.pgPassword || '', database: config.pgDbName || 'mem0' });
    return _pool;
  }
  return {
    name: 'postgres',
    config,
    async init() { /* pool created lazily */ },
    async list(limit, offset) {
      const pool = await getPool();
      const off = offset ? parseInt(offset, 10) : 0;
      const { rows } = await pool.query(`SELECT id, payload FROM ${table} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, off]);
      return { memories: rows.map(r => ({ id: r.id, ...(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) })), next_offset: rows.length === limit ? off + limit : null };
    },
    async search(query) {
      const pool = await getPool();
      const { rows } = await pool.query(`SELECT id, payload FROM ${table} WHERE payload->>'data' ILIKE $1 LIMIT 100`, [`%${query}%`]);
      return { memories: rows.map(r => ({ id: r.id, ...(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) })), next_offset: null };
    },
    async update(id, newData) {
      const pool = await getPool();
      const { rowCount } = await pool.query(`UPDATE ${table} SET payload = jsonb_set(payload, '{data}', $1::jsonb) WHERE id = $2`, [JSON.stringify(newData), id]);
      if (rowCount === 0) throw new Error('Memory not found');
      return { updated: true };
    },
    async delete(id) { const pool = await getPool(); await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]); return { deleted: true }; },
    async status() {
      try { const pool = await getPool(); const { rows } = await pool.query(`SELECT COUNT(*) as count FROM ${table}`); return { reachable: true, pointsCount: parseInt(rows[0].count, 10) }; }
      catch (err) { return { reachable: false, error: err.message }; }
    },
  };
}

export function createMemoryProvider(config) {
  if (config.provider === 'postgres' || config.provider === 'pgvector') return createPgProvider(config);
  return createQdrantProvider(config);
}
