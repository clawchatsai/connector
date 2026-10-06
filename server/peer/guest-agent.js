// Guest version of an agent, for sharing (clawchats specs/gateway-sharing.md → Safety).
//
// The gateway can't restrict most tools per session (permission modes only cover file tools and
// exec), so the real boundary is the agent's own config. A guest version has the original's model
// and personality (SOUL.md, IDENTITY.md) but not its private memory (MEMORY.md, USER.md), its own
// fresh workspace, and a tool deny list that removes messaging, scheduling, browsing, devices and
// access to other sessions. Created only when the owner asks for it (ClawChats → Sharing).

import path from 'node:path';

export const GUEST_TOOLS_DENY = [
  'gateway', 'openclaw', 'cron', 'nodes', 'browser', 'canvas', 'message',
  'sessions_spawn', 'sessions_send', 'sessions_history', 'sessions_list',
  'discord', 'slack', 'telegram', 'whatsapp',
];
const PERSONALITY_FILES = ['SOUL.md', 'IDENTITY.md'];
export const guestName = name => `${name} (guest)`;

const agentName = a => a?.identity?.name || a?.name || a?.id;
const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Make sure the guest's tool deny list is in the gateway config (idempotent; writes only when missing).
 * Runs before anything else touches a guest agent: a guest without it must never be shared.
 */
export async function ensureGuestRestrictions(request, agentId) {
  const cfg = await request('config.get', {});
  const deny = cfg?.parsed?.agents?.entries?.[agentId]?.tools?.deny;
  if (Array.isArray(deny) && GUEST_TOOLS_DENY.every(t => deny.includes(t))) return false;
  await request('config.patch', {
    raw: JSON.stringify({ agents: { entries: { [agentId]: { tools: { deny: GUEST_TOOLS_DENY } } } } }),
    ...(cfg?.hash ? { baseHash: cfg.hash } : {}),
    replacePaths: [`agents.entries.${agentId}.tools.deny`],
    note: `ClawChats sharing: guest restrictions for ${agentId}`,
  }, 60_000);
  return true;
}

/** A new agent is only usable once the gateway's config reload picked it up. */
async function waitForAgent(request, agentId, { tries = 40, ms = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (((await request('agents.list', {}))?.agents || []).some(a => a.id === agentId)) return true;
    await wait(ms);
  }
  return false;
}

/** The guest version of `agentId` if it already exists (by name). */
export function findGuestAgent(agents, agentId) {
  const src = agents.find(a => a.id === agentId);
  return src ? agents.find(a => agentName(a) === guestName(agentName(src))) || null : null;
}

/**
 * Create (or reuse) the guest version of an agent. Returns { agentId, name, created }.
 * @param {(m: string, p: object, t?: number) => Promise<any>} request  gateway RPC (operator.admin)
 */
export async function createGuestAgent(request, agentId) {
  const agents = (await request('agents.list', {}))?.agents || [];
  const src = agents.find(a => a.id === agentId);
  if (!src) throw new Error(`unknown agent: ${agentId}`);
  if (/\(guest\)$/.test(agentName(src))) {
    await ensureGuestRestrictions(request, src.id); // repairs a guest agent left without them
    return { agentId: src.id, name: agentName(src), created: false };
  }
  const existing = findGuestAgent(agents, agentId);
  if (existing) {
    await ensureGuestRestrictions(request, existing.id);
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

  // Personality only; never MEMORY.md / USER.md. Best effort (a guest without it still works).
  for (const file of PERSONALITY_FILES) {
    const got = await request('agents.files.get', { agentId: src.id, name: file }).catch(() => null);
    const content = got?.file && !got.file.missing ? got.file.content : null;
    if (typeof content !== 'string' || !content.trim()) continue;
    for (let i = 0; i < 5; i++) {
      try { await request('agents.files.set', { agentId: id, name: file, content }); break; }
      catch (e) { if (i === 4 || !/not found/i.test(e.message)) break; await wait(400); }
    }
  }
  return { agentId: id, name, created: true };
}
