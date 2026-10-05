// Guest version of an agent, for sharing (clawchats specs/gateway-sharing.md → Safety).
//
// The gateway can't restrict most tools per session (permission modes only cover file tools and
// exec), so the real boundary is the agent's own config. A guest version has the original's model
// and personality (SOUL.md, IDENTITY.md) but not its private memory (MEMORY.md, USER.md), its own
// fresh workspace, and a tool deny list that removes messaging, scheduling, browsing, devices and
// access to other sessions. Created only when the owner asks for it (ClawChats → Sharing).

export const GUEST_TOOLS_DENY = [
  'gateway', 'openclaw', 'cron', 'nodes', 'browser', 'canvas', 'message',
  'sessions_spawn', 'sessions_send', 'sessions_history', 'sessions_list',
  'discord', 'slack', 'telegram', 'whatsapp',
];
const PERSONALITY_FILES = ['SOUL.md', 'IDENTITY.md'];
export const guestName = name => `${name} (guest)`;

const agentName = a => a?.identity?.name || a?.name || a?.id;

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
  if (/\(guest\)$/.test(agentName(src))) return { agentId: src.id, name: agentName(src), created: false };
  const existing = findGuestAgent(agents, agentId);
  if (existing) return { agentId: existing.id, name: agentName(existing), created: false };

  const name = guestName(agentName(src));
  const model = typeof src.model === 'string' ? src.model : src.model?.primary;
  const created = await request('agents.create', {
    name, ...(model ? { model } : {}), ...(src.identity?.emoji ? { emoji: src.identity.emoji } : {}),
  }, 60_000);
  const id = created.agentId;

  // Personality only; never MEMORY.md / USER.md.
  for (const file of PERSONALITY_FILES) {
    const got = await request('agents.files.get', { agentId: src.id, name: file }).catch(() => null);
    const content = got?.file && !got.file.missing ? got.file.content : null;
    if (typeof content === 'string' && content.trim()) await request('agents.files.set', { agentId: id, name: file, content });
  }

  // Tool deny list on the guest agent (per-agent tools override the global ones).
  const cfg = await request('config.get', {});
  await request('config.patch', {
    raw: JSON.stringify({ agents: { entries: { [id]: { tools: { deny: GUEST_TOOLS_DENY } } } } }),
    ...(cfg?.hash ? { baseHash: cfg.hash } : {}),
    replacePaths: [`agents.entries.${id}.tools.deny`],
    note: `ClawChats sharing: guest version of ${agentName(src)}`,
  }, 60_000);
  return { agentId: id, name, created: true };
}
