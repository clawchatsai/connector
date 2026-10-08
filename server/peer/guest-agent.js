// Guest version of an agent, for sharing (clawchats specs/gateway-sharing.md → Safety).
//
// The gateway can't restrict most tools per session (permission modes only cover file tools and
// exec), so the real boundary is the agent's own config. A guest version has the original's model
// and personality (SOUL.md, IDENTITY.md) but not its private memory (MEMORY.md, USER.md), its own
// fresh workspace, and an allowlist of tools: files and exec, which the session's permission mode
// then limits (read-only, or guarded = the owner approves). Everything that reaches beyond its own
// folder (other sessions, messaging, scheduling, browsing, devices, plugins and MCP, secrets,
// gateway config) is denied on top, so it stays out even if the profile list grows. `view_image`
// and `pdf` are denied too: unlike the managed file tools they ignore the session's permission mode,
// so a guest could use them to read any local path (openclaw.json, MEMORY.md…) or reach an internal
// URL (SSRF). `fs.workspaceOnly` pins the managed file tools to the guest's own folder on top of the
// permission mode. Created only when the owner asks for it (ClawChats → Sharing).

import path from 'node:path';

/** The guest's tool policy (gateway `agents.entries.<id>.tools`; tool groups per docs/gateway/config-tools/tool-policy.md). */
export const GUEST_TOOLS = Object.freeze({
  profile: 'minimal',
  alsoAllow: ['group:fs', 'group:runtime'],
  deny: [
    'group:sessions', 'group:automation', 'group:ui', 'group:nodes', 'group:messaging', 'group:plugins',
    'group:agents', 'group:memory', 'group:web',
    'gateway', 'openclaw', 'cron', 'automations', 'plugins', 'secrets', 'personal_instructions', 'session_status',
    'sessions', 'sessions_spawn', 'sessions_send', 'sessions_history', 'sessions_list', 'sessions_search', 'subagents',
    'conversations_list', 'conversations_send', 'conversations_turn', 'message', 'nodes', 'computer', 'browser', 'canvas',
    'terminal', 'portal', 'skill_workshop', 'agents_list', 'image_generate', 'music_generate', 'video_generate', 'tts',
    'view_image', 'pdf',
    'discord', 'slack', 'telegram', 'whatsapp',
  ],
  fs: Object.freeze({ workspaceOnly: true }),
});
export const GUEST_TOOLS_DENY = GUEST_TOOLS.deny;
const PERSONALITY_FILES = ['SOUL.md', 'IDENTITY.md'];
export const guestName = name => `${name} (guest)`;

const agentName = a => a?.identity?.name || a?.name || a?.id;
const wait = ms => new Promise(r => setTimeout(r, ms));

/** Whether an agent's configured tools are (at least) as narrow as the guest policy. */
export function hasGuestRestrictions(tools) {
  if (!tools || tools.profile !== GUEST_TOOLS.profile || tools.allow) return false;
  if (!tools.fs || tools.fs.workspaceOnly !== true) return false; // file tools pinned to the guest's folder
  const also = Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
  const deny = Array.isArray(tools.deny) ? tools.deny : [];
  // `also` a subset of the allowlist: a guest whose alsoAllow still lists view_image/pdf (made before
  // they were removed) fails here and is re-patched on reuse; `_runGuestTurn` won't serve it meanwhile.
  return also.every(t => GUEST_TOOLS.alsoAllow.includes(t)) && GUEST_TOOLS.deny.every(t => deny.includes(t));
}

/**
 * Make sure the guest's tool policy is in the gateway config (idempotent; writes only when missing).
 * Runs before anything else touches a guest agent: a guest without it must never be shared.
 */
export async function ensureGuestRestrictions(request, agentId) {
  const cfg = await request('config.get', {});
  if (hasGuestRestrictions(cfg?.parsed?.agents?.entries?.[agentId]?.tools)) return false;
  await request('config.patch', {
    raw: JSON.stringify({ agents: { entries: { [agentId]: { tools: GUEST_TOOLS } } } }),
    ...(cfg?.hash ? { baseHash: cfg.hash } : {}),
    // The gateway only lets a patch shrink an array named exactly (a parent path doesn't count),
    // e.g. dropping view_image/pdf from an older guest's alsoAllow.
    replacePaths: ['', '.alsoAllow', '.deny'].map(p => `agents.entries.${agentId}.tools${p}`),
    note: `ClawChats sharing: guest restrictions for ${agentId}`,
  }, 60_000);
  return true;
}

/** A new agent is only usable once the gateway's config reload picked it up. */
async function waitForAgent(request, agentId, { tries = 120, ms = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (((await request('agents.list', {}))?.agents || []).some(a => a.id === agentId)) return true;
    await wait(ms);
  }
  return false;
}

/** Whether an agent is a guest version: called "<name> (guest)", or one this connector made (`known`: their ids). */
export function isGuestAgent(a, known = new Set()) {
  return /\(guest\)$/.test(agentName(a)) || known.has(a?.id);
}

/**
 * The guest version of `agentId` if it already exists. By name ("Jarvis (guest)"), or by the id it was made with
 * ("main-guest"): renaming the original ("main" -> "homiabot") changes the name it looks for, not the guest that
 * already exists. A guest the gateway shows under another name is still found when this connector made it (`known`).
 */
export function findGuestAgent(agents, agentId, known = new Set()) {
  const src = agents.find(a => a.id === agentId);
  if (!src) return null;
  return agents.find(a => agentName(a) === guestName(agentName(src)))
    || agents.find(a => a.id === `${agentId}-guest` && isGuestAgent(a, known))
    || agents.find(a => a.id.startsWith(`${agentId}-guest-`) && known.has(a.id)) || null;
}

/**
 * Create (or reuse) the guest version of an agent. Returns { agentId, name, created }.
 * @param {(m: string, p: object, t?: number) => Promise<any>} request  gateway RPC (operator.admin)
 */
export async function createGuestAgent(request, agentId, { known = new Set() } = {}) {
  const agents = (await request('agents.list', {}))?.agents || [];
  const src = agents.find(a => a.id === agentId);
  if (!src) throw new Error(`unknown agent: ${agentId}`);
  if (isGuestAgent(src, known)) {
    await ensureGuestRestrictions(request, src.id); // repairs a guest agent left without them
    return { agentId: src.id, name: agentName(src), created: false };
  }
  const existing = findGuestAgent(agents, agentId, known);
  if (existing) {
    // Repair a guest half-made by an earlier run: restore its restrictions, then the personality a
    // crash between create and copy would have skipped (only missing files; never clobber edits).
    await ensureGuestRestrictions(request, existing.id);
    await copyPersonality(request, src.id, existing.id, { onlyMissing: true });
    return { agentId: existing.id, name: agentName(existing), created: false };
  }

  const name = guestName(agentName(src));
  const model = typeof src.model === 'string' ? src.model : src.model?.primary;
  // Its own folder next to the original's workspace, not inside it (the default nests it in the
  // agents' workspace, where the owner's main agent would see it as part of its own files).
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'guest';
  const workspace = typeof src.workspace === 'string' && src.workspace.startsWith('/')
    ? path.join(path.dirname(src.workspace.replace(/\/+$/, '')), `workspace-${slug}`) : undefined;
  const created = await request('agents.create', {
    name, ...(workspace ? { workspace } : {}), ...(model ? { model } : {}), ...(src.identity?.emoji ? { emoji: src.identity.emoji } : {}),
  }, 60_000);
  const id = created.agentId;

  // Restrictions first: if anything after this fails, the agent is still safe to exist.
  await ensureGuestRestrictions(request, id);
  if (!(await waitForAgent(request, id))) throw new Error(`The gateway didn't load ${name} yet; try again`);

  await copyPersonality(request, src.id, id);
  return { agentId: id, name, created: true };
}

/**
 * Copy the original's personality (SOUL.md, IDENTITY.md) to the guest; never MEMORY.md / USER.md.
 * Best effort — a guest without it still works. With `onlyMissing`, leaves files the guest already
 * has (an owner may have edited the guest's copy), so repair fills gaps without clobbering.
 */
async function copyPersonality(request, srcId, destId, { onlyMissing = false } = {}) {
  for (const file of PERSONALITY_FILES) {
    if (onlyMissing) {
      const have = await request('agents.files.get', { agentId: destId, name: file }).catch(() => null);
      if (have?.file && !have.file.missing && typeof have.file.content === 'string' && have.file.content.trim()) continue;
    }
    const got = await request('agents.files.get', { agentId: srcId, name: file }).catch(() => null);
    const content = got?.file && !got.file.missing ? got.file.content : null;
    if (typeof content !== 'string' || !content.trim()) continue;
    for (let i = 0; i < 5; i++) {
      try { await request('agents.files.set', { agentId: destId, name: file, content }); break; }
      catch (e) { if (i === 4 || !/not found/i.test(e.message)) break; await wait(400); }
    }
  }
}
