// What one contact (a person this gateway shares with) may make this gateway's agents do: the contact card's settings,
// their defaults per Access tier, and how each maps onto the gateway's enforcement layers (clawchats specs, contact
// card spec CONTACT-CARD-DESIGN.md §3-4):
//   - the agent copy made for that person (`agents.entries.<copy>.tools`: profile, alsoAllow, deny, exec, fs);
//   - the copy's exec approvals entry (basic-commands allowlist);
//   - each guest session (permissionMode, toolOverrides: skills, mcpServers, webSearch);
//   - the agent's instructions (Private / Always fine: instruction only).
// Pure functions only: contacts.js stores the settings, guest-agent.js writes the copy, sharing.js runs the turns.

import crypto from 'node:crypto';
import { GUEST_TOOLS_DENY } from './guest-agent.js';

export const ACCESS = ['restricted', 'trusted', 'full'];
export const COMMANDS = ['off', 'basic', 'ask', 'auto'];
export const KNOWLEDGE = ['none', 'notes'];

/**
 * Autonomy tiers (D10): how much this gateway's agents answer the person's agents on their own. One counter per
 * person counts both their own questions and agent replies. `rounds` caps agent-to-agent rounds per human message
 * (0: agents never answer the person's agents; the person can still ask).
 */
export const AUTONOMY = Object.freeze({
  notify: Object.freeze({ rounds: 0, perDay: 50 }),
  bounded: Object.freeze({ rounds: 3, perDay: 50 }),
  extended: Object.freeze({ rounds: 10, perDay: 288, perHour: 12 }),
});

/**
 * Tools on the card, grouped as the card shows them. `personal`: reaches the owner's accounts. Commands are set by the
 * Commands tier, not ticked. Always-off tools are never allowed for a contact, whatever is ticked.
 */
export const TOOL_GROUPS = Object.freeze([
  { id: 'files', title: 'Files', tools: ['read', 'write', 'edit', 'apply_patch'] },
  { id: 'commands', title: 'Commands', tools: ['exec', 'process'], byCommands: true },
  { id: 'web', title: 'Web', tools: ['web_search', 'web_fetch'] },
  { id: 'media', title: 'Media', tools: ['view_image', 'pdf', 'image_generate', 'tts'] },
  { id: 'memory', title: 'Memory', tools: ['memory_search', 'memory_get', 'wiki_search'] },
  { id: 'accounts', title: 'Reaches your accounts', tools: ['message', 'browser', 'nodes', 'computer', 'talk_voice'], personal: true },
  { id: 'gateway', title: 'Your gateway', tools: ['sessions_list', 'sessions_history', 'subagents', 'cron', 'canvas', 'dashboard'] },
]);
export const ALWAYS_OFF = Object.freeze(['gateway', 'openclaw', 'plugins', 'secrets', 'handoff', 'skill_workshop', 'agents_list']);
const TICKABLE = new Set(TOOL_GROUPS.filter(g => !g.byCommands).flatMap(g => g.tools));
const FILE_TOOLS = ['read', 'write', 'edit', 'apply_patch'];
const WRITE_TOOLS = ['write', 'edit', 'apply_patch'];
// The groups a copy denies as a whole (from the old guest policy), with the tools in each a contact could tick.
// A ticked tool lifts its group's deny; the group's other members are then denied one by one.
const GROUP_MEMBERS = Object.freeze({
  'group:fs': FILE_TOOLS,
  'group:web': ['web_search', 'x_search', 'web_fetch'],
  'group:memory': ['memory_search', 'memory_get'],
  'group:ui': ['browser', 'screen', 'theme', 'dashboard', 'terminal', 'portal', 'canvas', 'show_widget'],
  'group:nodes': ['nodes', 'computer'],
  'group:messaging': ['message'],
  'group:automation': ['automations', 'cron', 'gateway', 'plugins', 'openclaw'],
  'group:sessions': ['sessions', 'sessions_list', 'sessions_history', 'sessions_search', 'conversations_list', 'conversations_send',
    'conversations_turn', 'sessions_send', 'sessions_spawn', 'sessions_yield', 'subagents', 'session_status', 'suggest_task', 'dismiss_task'],
});

export const DEFAULT_SKILLS = Object.freeze(['weather', 'diagram-maker', 'visualize']);

/** Tools ticked by default per Access tier (§3). */
export const DEFAULT_TOOLS = Object.freeze({
  restricted: Object.freeze(['read', 'view_image', 'pdf']),
  trusted: Object.freeze(['read', 'write', 'edit', 'apply_patch', 'view_image', 'pdf', 'web_search', 'web_fetch']),
  full: Object.freeze(['memory_search', 'memory_get', 'view_image', 'pdf', 'web_search', 'web_fetch']),
});
export const DEFAULT_COMMANDS = Object.freeze({ restricted: 'basic', trusted: 'ask', full: 'ask' });

/** A new contact's settings (first-time accept: Trusted, Bounded, My notes with the default picks). */
export function defaultContact(access = 'trusted') {
  return {
    access, autonomy: 'bounded', knowledge: 'notes', notes: null, repos: [], agents: null,
    tools: [...DEFAULT_TOOLS[access]], commands: DEFAULT_COMMANDS[access], basicList: null,
    skills: [...DEFAULT_SKILLS], mcp: {}, mcpToolsDeny: {}, private: '', alwaysFine: '', openFolder: null,
  };
}

/**
 * The tools a contact may actually get: ticked ∩ tickable, with the tier's hard limits. Full agent never writes
 * (memory read-only, D7) and reads files only when one folder is opened (§12: secrets/ lives in the workspace).
 */
export function effectiveTools(c) {
  let t = (Array.isArray(c.tools) ? c.tools : []).filter(x => TICKABLE.has(x));
  if (c.access === 'full') {
    // Reading is "Open one folder" itself, not a tick (the session root keeps it to that folder).
    t = t.filter(x => !WRITE_TOOLS.includes(x) && x !== 'read');
    if (c.openFolder) t.push('read');
  } else {
    t = t.filter(x => !['memory_search', 'memory_get', 'wiki_search'].includes(x)); // copies have no memory of the owner's
  }
  return [...new Set(t)].sort();
}

/** Copy exec settings per Commands tier (§4). `reviewerModel` only for Auto-review. */
export function execConfig(commands, reviewerModel = null) {
  const mode = { off: 'deny', basic: 'allowlist', ask: 'ask', auto: 'auto' }[commands] || 'deny';
  return {
    mode, strictInlineEval: true, safeBins: ['head', 'tail', 'wc', 'cut', 'uniq', 'tr'],
    ...(mode === 'auto' && reviewerModel ? { reviewer: { model: reviewerModel } } : {}),
  };
}

/**
 * The session's permission mode per Commands tier. Basic only and Off run with none (null): a session mode overrides
 * the copy's exec policy, and a `guarded` session would turn allowlist misses back into approval cards (spike run 1).
 * "Open one folder" needs a mode for its session root: refused for Off/Basic (card) and kept at guarded here.
 */
export function sessionMode(c) {
  if (c.commands === 'ask') return 'guarded';
  if (c.commands === 'auto') return 'workspace';
  return null;
}

/** The copy's `tools` config: an allowlist on the minimal profile, everything else denied on top. */
export function copyTools(c, { reviewerModel = null, autoApproveChanges = true } = {}) {
  const allowed = effectiveTools(c);
  const execOn = c.commands !== 'off';
  const mcpOn = Object.values(c.mcp || {}).some(Boolean);
  const alsoAllow = [...allowed, ...(execOn ? ['exec', 'process'] : []), ...(mcpOn ? ['bundle-mcp'] : [])];
  const lifted = new Set(alsoAllow);
  const deny = new Set();
  for (const d of [...GUEST_TOOLS_DENY, ...ALWAYS_OFF]) {
    const members = GROUP_MEMBERS[d];
    if (members && members.some(m => lifted.has(m))) { for (const m of members) if (!lifted.has(m)) deny.add(m); continue; }
    if (d === 'group:plugins' && (mcpOn || lifted.has('memory_search') || lifted.has('memory_get'))) continue; // MCP, memory-core
    if (!lifted.has(d)) deny.add(d);
  }
  for (const g of TOOL_GROUPS) for (const t of g.tools) if (!lifted.has(t)) deny.add(t);
  if (!execOn) { deny.add('exec'); deny.add('process'); deny.add('group:runtime'); }
  for (const t of ALWAYS_OFF) deny.add(t);
  return {
    profile: 'minimal', alsoAllow: alsoAllow.sort(), deny: [...deny].sort(),
    fs: { workspaceOnly: true },
    exec: execConfig(c.commands, reviewerModel),
    ...(autoApproveChanges ? { openclaw: { autoApproveChanges: false } } : {}),
  };
}

/** Whether a copy's configured tools still hold the policy written for it (else its turns are refused). */
export function copyToolsHold(tools, want) {
  if (!tools || tools.profile !== want.profile || tools.allow) return false;
  if (tools.fs?.workspaceOnly !== true) return false;
  const also = new Set(Array.isArray(tools.alsoAllow) ? tools.alsoAllow : []);
  const deny = new Set(Array.isArray(tools.deny) ? tools.deny : []);
  if ([...also].some(t => !want.alsoAllow.includes(t))) return false;
  if (want.deny.some(t => !deny.has(t))) return false;
  return (tools.exec?.mode || null) === want.exec.mode;
}

// ── Basic commands (§4 "Default basic list") ─────────────────────────

/** Default list: bare command + anchored argPattern; `args` is what the card shows. */
export const BASIC_DEFAULTS = Object.freeze([
  { pattern: 'openclaw', argPattern: '^(--version|-V)$', args: '--version' },
  { pattern: 'uname', argPattern: '^(-[asrmnvpio]+)?$', args: '-a, -r, -m …' },
  { pattern: 'uptime', argPattern: '^(-p|-s)?$', args: '(none), -p' },
  { pattern: 'df', argPattern: '^(-h|-hT|-h -T)?$', args: '-h' },
  { pattern: 'free', argPattern: '^(-h|-m|-g)?$', args: '-h' },
  { pattern: 'nproc', argPattern: '^$', args: '(none)' },
  { pattern: 'lscpu', argPattern: '^$', args: '(none)' },
  { pattern: 'date', argPattern: '^$', args: '(none)' },
  { pattern: 'cat', argPattern: '^/etc/os-release$', args: '/etc/os-release only' },
  { pattern: 'node', argPattern: '^(--version|-v|-V)$', args: '--version' },
  { pattern: 'npm', argPattern: '^(--version|-v|-V)$', args: '--version' },
  { pattern: 'python3', argPattern: '^(--version|-v|-V)$', args: '--version' },
]);
const GIT_ARGS = '(log( --oneline)?( -n ?[0-9]{1,3}| -[0-9]{1,3})?|status( -s| --short)?|describe --tags|rev-parse --short HEAD|branch --show-current)';
const reEscape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One git entry per repo picked under Knowledge (D4): read-only subcommands, in that repo only. */
export function gitEntries(repos) {
  return (Array.isArray(repos) ? repos : []).filter(r => typeof r === 'string' && r.startsWith('/'))
    .map(r => ({ pattern: 'git', argPattern: `^-C ${reEscape(r.replace(/\/+$/, ''))} ${GIT_ARGS}$`, args: `-C ${r} log, status, describe…`, repo: r }));
}

// Commands that read anything, run code or reach out: only with an anchored argPattern.
const RISKY = /^(cat|less|more|head|tail|env|printenv|bash|sh|zsh|dash|fish|python[0-9.]*|node|deno|bun|perl|ruby|php|curl|wget|ssh|scp|nc|ncat|openclaw|sudo|find|xargs|docker|journalctl|systemctl)$/;
const anchored = p => typeof p === 'string' && p.startsWith('^') && p.endsWith('$') && !/(^|[^\\])\.\*/.test(p);

/**
 * Check one entry of an edited basic list: { ok, error?, warning? }. A bare command name only (no paths or globs), an
 * argPattern that compiles, and for anything risky an anchored one with no `.*`.
 */
export function validateBasicEntry({ pattern, argPattern } = {}) {
  const cmd = String(pattern || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(cmd)) return { ok: false, error: 'Use a bare command name, like "uptime" (no paths or wildcards)' };
  if (argPattern != null && argPattern !== '') {
    try { new RegExp(argPattern); } catch { return { ok: false, error: 'The arguments pattern isn\'t a valid regular expression' }; }
  }
  if (RISKY.test(cmd) && !anchored(argPattern)) {
    return { ok: false, error: `"${cmd}" can read files, run code or reach out: give it an exact arguments pattern (^…$, no .*)` };
  }
  if (!argPattern) return { ok: true, warning: `Any arguments to "${cmd}" will run without asking` };
  if (/\.openclaw/.test(argPattern)) return { ok: true, warning: 'This pattern mentions .openclaw, where your gateway config and secrets live' };
  return { ok: true };
}

/** The list the copy's approvals entry allows: the edited or default list, plus the git entries. */
export function basicList(c) {
  const base = Array.isArray(c.basicList) ? c.basicList.filter(e => validateBasicEntry(e).ok) : BASIC_DEFAULTS;
  return [...base.map(({ pattern, argPattern, args }) => ({ pattern, argPattern: argPattern || undefined, args })), ...gitEntries(c.repos)];
}

/** The copy's entry in the exec approvals document (`agents.<copy>`). */
export function approvalsEntry(c) {
  const ask = c.commands === 'ask' || c.commands === 'auto' ? 'on-miss' : 'off';
  return {
    security: c.commands === 'off' ? 'deny' : 'allowlist', ask, askFallback: 'deny', autoAllowSkills: false,
    allowlist: c.commands === 'off' ? [] : basicList(c).map(({ pattern, argPattern }) => (argPattern ? { pattern, argPattern } : { pattern })),
  };
}

// ── Session overrides ──────────────────────────────────────────────

/** `toolOverrides` for the person's sessions: every known skill/MCP server set explicitly, so new ones start off. */
export function toolOverrides(c, { skillNames = [], mcpServers = [] } = {}) {
  const on = new Set(Array.isArray(c.skills) ? c.skills : []);
  const skills = Object.fromEntries([...new Set(skillNames)].sort().map(n => [n, on.has(n)]));
  const mcp = Object.fromEntries([...new Set(mcpServers)].sort().map(n => [n, !!c.mcp?.[n]]));
  const deny = Object.fromEntries(Object.entries(c.mcpToolsDeny || {}).filter(([s, l]) => mcp[s] && Array.isArray(l) && l.length).map(([s, l]) => [s, [...l].sort()]));
  return {
    webSearch: effectiveTools(c).includes('web_search'),
    ...(Object.keys(skills).length ? { skills } : {}),
    ...(Object.keys(mcp).length ? { mcpServers: mcp } : {}),
    ...(Object.keys(deny).length ? { mcpToolsDeny: deny } : {}),
  };
}

/** Private / Always fine, for the agent's instructions while that person is in the conversation (instruction only). */
export function topicsNote(c, name) {
  const clean = s => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, 1000);
  const priv = clean(c.private), fine = clean(c.alwaysFine);
  const lines = [];
  if (priv) lines.push(`Your owner keeps these topics private from ${name} and ${name}'s agents: don't discuss them, and say so briefly if asked: ${priv}`);
  if (fine) lines.push(`Your owner is happy for you to share these with ${name} freely: ${fine}`);
  return lines.map(l => `(${l})`).join('\n');
}

/** A stable hash of everything written to a copy (config + approvals), to tell when it must be rewritten. */
export function policyHash(obj) {
  const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
  return crypto.createHash('sha256').update(JSON.stringify(canon(obj))).digest('hex').slice(0, 16);
}

/** Copy ids: `<agent>-guest-<slug>` / `<agent>-full-<slug>` (D3). The slug is the email's local part plus a short hash. */
export function copySlug(personKey) {
  const local = String(personKey || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'contact';
  return `${local}-${crypto.createHash('sha256').update(String(personKey)).digest('hex').slice(0, 4)}`;
}
export const copyKind = c => (c.access === 'full' ? 'full' : 'guest');
