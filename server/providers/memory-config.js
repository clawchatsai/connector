import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Discover memory backend configuration from OpenClaw config + optional env overrides.
 * env vars (MEMORY_PROVIDER, QDRANT_HOST, etc.) are read by the plugin host (src/index.ts)
 * and passed in via envOverrides to keep env vars out of the server bundle.
 *
 * This file is intentionally network-free: it only reads local config files.
 * The actual provider implementations (Qdrant, Postgres) live in memory.js.
 */
export function discoverMemoryConfig(envOverrides = {}) {
  const defaults = { provider: 'qdrant', host: 'localhost', port: 6333, collection: null };
  let oc = null;
  for (const cfgPath of [path.join(os.homedir(), '.openclaw', 'openclaw.json'), '/etc/openclaw/openclaw.json']) {
    try { oc = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); break; } catch { /* try next */ }
  }

  let cfg = { ...defaults };
  if (oc) {
    const vs = oc.plugins?.slots?.memory
      ? oc.plugins?.entries?.[oc.plugins.slots.memory]?.config?.oss?.vectorStore
      : null;
    if (vs) {
      if (vs.provider)             cfg.provider   = vs.provider;
      if (vs.config?.host)         cfg.host       = vs.config.host;
      if (vs.config?.port)         cfg.port       = vs.config.port;
      if (vs.config?.collectionName) cfg.collection = vs.config.collectionName;
      if (vs.config?.user)         cfg.pgUser     = vs.config.user;
      if (vs.config?.password)     cfg.pgPassword = vs.config.password;
      if (vs.config?.dbname)       cfg.pgDbName   = vs.config.dbname;
    }
    const wsDir = oc.agents?.defaults?.workspace;
    if (wsDir) cfg.workspaceDir = wsDir;
  }

  if (envOverrides.provider)   cfg.provider    = envOverrides.provider;
  if (envOverrides.host)       cfg.host        = envOverrides.host;
  if (envOverrides.port)       cfg.port        = parseInt(envOverrides.port, 10);
  if (envOverrides.collection) cfg.collection  = envOverrides.collection;
  if (envOverrides.pgUrl)      cfg.pgUrl       = envOverrides.pgUrl;
  if (envOverrides.qdrantUrl && !envOverrides.host) {
    try {
      const u = new URL(envOverrides.qdrantUrl);
      cfg.host = u.hostname;
      if (u.port) cfg.port = parseInt(u.port, 10);
    } catch { /* ignore */ }
  }
  if (!cfg.workspaceDir) cfg.workspaceDir = path.join(os.homedir(), '.openclaw', 'workspace');
  return cfg;
}
