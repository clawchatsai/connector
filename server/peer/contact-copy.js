// The agent copies made per person (D3): `<agent>-guest-<slug>` (Restricted/Trusted: its own folder, the original's
// personality, the picked notes) and `<agent>-full-<slug>` (Full agent: the original's workspace, memory read-only, no
// file tools unless one folder is opened). Each copy carries the contact's tool policy in its config entry and its basic
// commands in the exec approvals document. Writes are idempotent by policy hash (contacts.js peer_copy).

import fs from 'node:fs';
import path from 'node:path';
import { copyTools, approvalsEntry, policyHash, copySlug } from './contact-policy.js';
import { persistedButNotApplied } from './guest-agent.js';

const PERSONALITY_FILES = ['SOUL.md', 'IDENTITY.md'];
const agentName = a => a?.identity?.name || a?.name || a?.id;
const wait = ms => new Promise(r => setTimeout(r, ms));
const isValidation = e => /invalid|unexpected property|must not have additional|unknown (key|field)|unrecognized/i.test(e?.message || '');

export const copyIdFor = (agentId, personKey, kind) => `${agentId}-${kind}-${copySlug(personKey)}`;

/**
 * Create or update one person's copy of one agent. Returns { copyId, created, changed }.
 * @param {object} o
 * @param {(m, p, t?) => Promise<any>} o.request  gateway RPC (operator.admin)
 * @param {object} o.contact   contacts.js contact
 * @param {string} o.agentId   the original agent
 * @param {string} o.firstName the person's first name (copy display name)
 * @param {object|null} o.known  { copyId, policyHash } from peer_copy
 */
export async function ensureContactCopy({ request, contact, agentId, firstName, known = null, log = console }) {
  const kind = contact.access === 'full' ? 'full' : 'guest';
  const agents = (await request('agents.list', {}))?.agents || [];
  const src = agents.find(a => a.id === agentId);
  if (!src) throw new Error(`unknown agent: ${agentId}`);
  let cfg = await request('config.get', {}, 30_000);
  const tools = copyTools(contact);
  const approvals = approvalsEntry(contact);
  const hash = policyHash({ tools, approvals, kind });

  const wantId = copyIdFor(agentId, contact.personKey, kind);
  let copyId = known?.copyId && agents.some(a => a.id === known.copyId) ? known.copyId : null;
  let created = false;
  if (!copyId) {
    copyId = agents.some(a => a.id === wantId) ? wantId : null;
    if (!copyId) {
      copyId = await createCopy(request, src, { wantId, kind, firstName });
      created = true;
    }
  }
  // Full: made in a staging folder (createCopy), then pointed at the original's workspace once its policy is on. A copy
  // a failed write left in the staging folder is pointed there on its next ensure.
  const home = kind === 'full' ? homeOf(src) : null;
  const at = created ? stagingDir(home, wantId) : agents.find(a => a.id === copyId)?.workspace;
  const moveHome = !!home && String(at || '').replace(/\/+$/, '') !== home;
  if (!created && !moveHome && known?.policyHash === hash && copyId === known.copyId && toolsWritten(cfg, copyId, tools)) return { copyId, created, changed: false, hash };

  // Policy first: if anything after this fails, the copy is still locked down.
  const pending = await patchTools(request, copyId, tools, cfg);
  await setApprovals(request, copyId, approvals);
  if (moveHome) {
    await setWorkspace(request, copyId, home);
    fs.rmSync(stagingDir(home, wantId), { recursive: true, force: true });
  }
  if (created) {
    if (!(await waitForAgent(request, copyId))) throw new Error("The gateway didn't load the copy yet; try again");
    if (kind === 'guest') await copyPersonality(request, src.id, copyId);
  }
  log.info?.(`[sharing] copy ${copyId} for ${contact.personKey}: ${created ? 'created' : 'updated'}`);
  return { copyId, created, changed: true, hash, pending };
}

async function createCopy(request, src, { wantId, kind, firstName }) {
  const name = `${agentName(src)} (${kind === 'full' ? 'full' : 'guest'} · ${firstName})`;
  const model = typeof src.model === 'string' ? src.model : src.model?.primary;
  // Guest: its own folder beside the original's workspace (never inside it). Full: the original's workspace (§12), but
  // made in a staging folder and pointed there afterwards (ensureContactCopy): agents.create on an existing, set-up folder
  // writes the new agent's name into its IDENTITY.md and runs the gateway's first-run check in it (2026.11.6), which
  // rewrote the owner's own IDENTITY.md (clawchats specs/bugs/2026-11-23-full-copy-owner-identity.md). Setting the
  // workspace in config touches no files.
  const base = homeOf(src);
  const workspace = kind === 'full' ? stagingDir(base, wantId) : base ? path.join(path.dirname(base), `workspace-${wantId}`) : undefined;
  const params = { name, ...(workspace ? { workspace } : {}), ...(model ? { model } : {}), ...(src.identity?.emoji ? { emoji: src.identity.emoji } : {}) };
  return createAgent(request, params, wantId);
}

const homeOf = src => (typeof src.workspace === 'string' && src.workspace.startsWith('/') ? src.workspace.replace(/\/+$/, '') : null);
const stagingDir = (home, wantId) => (home ? path.join(path.dirname(home), `.clawchats-staging-${wantId}`) : undefined);

async function createAgent(request, params, wantId) {
  try {
    return (await request('agents.create', { ...params, agentId: wantId }, 60_000)).agentId;
  } catch (e) {
    if (!isValidation(e)) throw e;
    // 2026.9.x: no agentId; the id comes from the name. Two people with the same first name: the second gets the
    // slug's short hash in its name (and so in its id).
    try { return (await request('agents.create', params, 60_000)).agentId; }
    catch (e2) {
      if (!/exist|already|duplicate|taken|in use/i.test(e2.message)) throw e2;
      return (await request('agents.create', { ...params, name: `${params.name.slice(0, -1)} ${wantId.slice(-4)})` }, 60_000)).agentId;
    }
  }
}

/** Point an agent at a folder in config (no files written there). */
async function setWorkspace(request, agentId, workspace) {
  for (let attempt = 0; ; attempt++) {
    const cfg = await request('config.get', {}, 30_000);
    try {
      await request('config.patch', {
        raw: JSON.stringify({ agents: { entries: { [agentId]: { workspace } } } }),
        ...(cfg?.hash ? { baseHash: cfg.hash } : {}),
        note: `ClawChats sharing: ${agentId} works in its original's workspace`,
      }, 60_000);
      return;
    } catch (e) {
      if (e?.gatewayCode === 'UNAVAILABLE' && e.details?.persistedConfig) return; // saved; applies with the copy's policy
      if (!/hash|changed since|conflict/i.test(e.message) || attempt >= 2) throw e;
    }
  }
}

function toolsWritten(cfg, copyId, tools) {
  const have = cfg?.parsed?.agents?.entries?.[copyId]?.tools;
  // 2026.9.x has no tools.openclaw (patchTools drops it there).
  if (have && !have.openclaw && tools.openclaw) { const { openclaw, ...rest } = tools; tools = rest; }
  return JSON.stringify(sortDeep(have || null)) === JSON.stringify(sortDeep(tools));
}
const sortDeep = v => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])])) : v);

async function patchTools(request, copyId, tools, cfg) {
  const send = async (t, c) => request('config.patch', {
    raw: JSON.stringify({ agents: { entries: { [copyId]: { tools: t } } } }),
    ...(c?.hash ? { baseHash: c.hash } : {}),
    replacePaths: ['', '.alsoAllow', '.deny', '.exec', '.exec.safeBins'].map(p => `agents.entries.${copyId}.tools${p}`),
    note: `ClawChats sharing: contact policy for ${copyId}`,
  }, 60_000);
  // Returns true when the gateway saved the policy but hasn't applied it yet (2026.11.4+: a deferred reload).
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await send(tools, cfg); return false; }
    catch (e) {
      if (persistedButNotApplied(e, copyId)) return true;
      if (/hash|changed since|conflict/i.test(e.message) && attempt < 2) { cfg = await request('config.get', {}, 30_000); continue; }
      if (isValidation(e) && tools.openclaw) { const { openclaw, ...rest } = tools; tools = rest; continue; } // older gateway
      throw e;
    }
  }
}

/** Merge the copy's entry into the exec approvals document (other agents' entries untouched). */
export async function setApprovals(request, copyId, entry) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snap = await request('exec.approvals.get', {}, 30_000);
    const file = snap?.file && typeof snap.file === 'object' ? structuredClone(snap.file) : { version: 1 };
    file.agents = { ...(file.agents || {}) };
    if (entry === null) delete file.agents[copyId];
    else file.agents[copyId] = { ...(file.agents[copyId] || {}), ...entry };
    try { await request('exec.approvals.set', { file, ...(snap?.hash ? { baseHash: snap.hash } : {}) }, 30_000); return; }
    catch (e) { if (attempt === 2 || !/hash|stale|changed/i.test(e.message)) throw e; }
  }
}

/**
 * Retire a copy (Disconnect): every tool denied, commands off, its approvals entry removed. The agent stays, because
 * deleting an agent deletes its sessions too (2026.11.6, checked live), and the owner keeps those chats (archived).
 * A later reconnect with the same person rewrites it to the new card.
 */
export const RETIRED_TOOLS = Object.freeze({
  profile: 'minimal', alsoAllow: [],
  deny: ['group:fs', 'group:runtime', 'group:web', 'group:memory', 'group:media', 'group:ui', 'group:nodes', 'group:messaging',
    'group:automation', 'group:sessions', 'group:agents', 'group:plugins', 'group:openclaw', 'gateway', 'openclaw', 'bundle-mcp'],
  fs: { workspaceOnly: true }, exec: { mode: 'deny' },
});
export async function retireCopy(request, copyId) {
  await setApprovals(request, copyId, null).catch(() => {});
  const cfg = await request('config.get', {}, 30_000);
  if (!cfg?.parsed?.agents?.entries?.[copyId] && !((await request('agents.list', {}))?.agents || []).some(a => a.id === copyId)) return false;
  await patchTools(request, copyId, RETIRED_TOOLS, cfg);
  return true;
}

async function waitForAgent(request, agentId, { tries = 120, ms = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (((await request('agents.list', {}))?.agents || []).some(a => a.id === agentId)) return true;
    await wait(ms);
  }
  return false;
}

async function copyPersonality(request, srcId, destId) {
  for (const file of PERSONALITY_FILES) {
    const got = await request('agents.files.get', { agentId: srcId, name: file }).catch(() => null);
    const content = got?.file && !got.file.missing ? got.file.content : null;
    if (typeof content !== 'string' || !content.trim()) continue;
    for (let i = 0; i < 5; i++) {
      try { await request('agents.files.set', { agentId: destId, name: file, content }); break; }
      catch (e) { if (i === 4 || !/not found/i.test(e.message)) break; await wait(400); }
    }
  }
}
