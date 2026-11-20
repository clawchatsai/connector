// Knowledge "My notes" (contact card): read-only copies of the notes the owner picked, in a `notes/` folder of each
// agent copy made for that person. The copy reads them with its own file tools (fs.workspaceOnly keeps it in its
// folder), so the owner's real memory is never reachable. Copies go through redactSecrets, are written 0444 (the
// folders stay 0755: a read-only folder would stop the owner's own tools from deleting the copy), and symlinks are
// never followed. Re-synced when the picks change, on "Sync now", and before a turn when a
// source file changed.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { redactSecrets } from '../util/redact.js';

export const NOTES_DIR = 'notes';
const MAX_FILE = 256 * 1024;
// Off by default (D10): infrastructure notes, and anything named like it holds credentials.
const DEFAULT_OFF = /^(homelab|openclaw-gateway-ops)\.md$|secret|credential|password|token|vault/i;

/** Notes the card offers from an agent workspace: top-level `memory/projects/*.md` only (never daily notes, MEMORY.md, USER.md, reference/, imports/). */
export function noteCandidates(workspaces) {
  const out = [];
  for (const ws of new Set((workspaces || []).filter(w => typeof w === 'string' && path.isAbsolute(w)))) {
    const dir = path.join(ws, 'memory', 'projects');
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.md')).map(d => d.name).sort(); } catch { continue; }
    for (const name of names) {
      const p = path.join(dir, name);
      const st = safeStat(p);
      if (!st) continue;
      out.push({ path: p, name, group: 'projects', root: dir, size: st.size, mtimeMs: st.mtimeMs, defaultOn: !DEFAULT_OFF.test(name) });
    }
  }
  return out;
}

/** The git repo a path is in (the folder holding `.git`), or null. */
export function repoOf(p) {
  let dir = path.dirname(p);
  for (let i = 0; i < 30 && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
  }
  return null;
}

/**
 * Whether a file may be offered as a repo doc: a Markdown file (no symlink anywhere on its path), inside a git repo, not
 * under ~/.openclaw, at most 256 KB. Returns { ok, path, repo, error }.
 */
export function checkRepoDoc(input, { home = os.homedir() } = {}) {
  const raw = String(input || '').trim().replace(/^~(?=\/)/, home);
  if (!path.isAbsolute(raw)) return { ok: false, error: 'Use the full path of a .md file in one of your git repos' };
  const p = path.normalize(raw);
  let real;
  try { real = fs.realpathSync(p); } catch { return { ok: false, error: "That file doesn't exist" }; }
  if (real !== p) return { ok: false, error: "That path goes through a link; use the file's real path" };
  if (!/\.md$/i.test(p)) return { ok: false, error: 'Only Markdown (.md) files' };
  if (p.split(path.sep).some(seg => seg === '.openclaw') || p.startsWith(path.join(home, '.openclaw'))) return { ok: false, error: 'Nothing under ~/.openclaw' };
  const st = safeStat(p);
  if (!st?.isFile()) return { ok: false, error: 'Not a file' };
  if (st.size > MAX_FILE) return { ok: false, error: 'Too big (256 KB at most)' };
  const repo = repoOf(p);
  if (!repo) return { ok: false, error: 'Only files inside a git repo' };
  return { ok: true, path: p, repo, size: st.size, mtimeMs: st.mtimeMs, name: path.relative(path.dirname(repo), p) };
}

/** The picked files that exist and are allowed: [{ src, dest (relative to notes/) }]. */
export function resolvePicks(picks, candidates) {
  const byPath = new Map(candidates.map(c => [c.path, c]));
  const out = [];
  for (const p of picks || []) {
    const cand = byPath.get(p);
    if (cand) { out.push({ src: p, dest: cand.name }); continue; }
    const doc = checkRepoDoc(p);
    if (doc.ok) out.push({ src: doc.path, dest: path.join('repos', doc.name) });
  }
  return out;
}

/** What the picked files look like now (to tell whether a re-sync is due). */
export function picksSignature(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) { const st = safeStat(f.src); h.update(`${f.src}|${f.dest}|${st?.size ?? -1}|${st?.mtimeMs ?? -1}\n`); }
  return h.digest('hex').slice(0, 16);
}

/**
 * Write the picked notes into `<workspace>/notes/`, replacing what was there. Returns { files, bytes, secretsRemoved,
 * at, signature }. Never follows symlinks (a source that became one is skipped).
 */
export function syncNotes(workspace, files) {
  const root = path.join(workspace, NOTES_DIR);
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('notes folder is a link: refusing');
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  let bytes = 0, secretsRemoved = 0, count = 0;
  for (const f of files) {
    const st = fs.lstatSync(f.src, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE) continue;
    const text = redactSecrets(fs.readFileSync(f.src, 'utf8'), () => { secretsRemoved++; });
    const dest = path.join(root, f.dest);
    if (!dest.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, { mode: 0o444 });
    fs.chmodSync(dest, 0o444);
    bytes += Buffer.byteLength(text);
    count++;
  }
  return { files: count, bytes, secretsRemoved, at: Date.now(), signature: picksSignature(files) };
}

/** Remove a copy's notes (its folders are read-only). */
export function removeNotes(workspace) {
  const root = path.join(workspace, NOTES_DIR);
  if (!fs.existsSync(root)) return;
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function makeWritable(dir) {
  if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) return;
  fs.chmodSync(dir, 0o755);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) makeWritable(path.join(dir, e.name));
}

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
