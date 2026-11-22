// Project instructions: text the user writes in a project's settings, added to every chat of that project through
// a before_prompt_build hook (same path as progress-reminder.js; needs hooks.allowConversationAccess).
//
// Which turns get them (design: clawchats specs/project-instructions.md §8b). The gateway has no owner signal for
// claude-cli turns, and guest turns reach it through this connector with the owner's credentials, so the decision is
// per chat, made here:
//   - The session's chat is found by walking spawned children up to their top-level chat (any depth).
//   - A top-level chat of the user's own gets the instructions of its project.
//   - Team chats (the room, its working sessions and their children) get them only when the project allows it
//     ("Also in team chats"): other people read and write there.
//   - Sessions where an agent answers in someone else's team chat, channel chats (Discord, WhatsApp, ...), the main
//     session, cron runs and anything else the connector can't place get nothing.
// Any error means no instructions: they help a turn, they never block one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 'active': the hook is registered. 'blocked': needs allowConversationAccess. 'off': prompt hooks turned off. */
export function instructionsState(cfg, pluginId) {
  const hooks = cfg?.plugins?.entries?.[pluginId]?.hooks;
  if (hooks?.allowPromptInjection === false) return 'off';
  return hooks?.allowConversationAccess === true ? 'active' : 'blocked';
}

export function formatInstructions(project, text) {
  return `## Project instructions: ${project}\n`
    + `The user wrote these for every chat in their ClawChats project "${project}". Follow them as you follow your workspace instructions.\n\n`
    + text;
}

/**
 * @param {object} opts
 * @param {object} opts.lens    SessionLens (rootOf, categoryOf)
 * @param {object} [opts.team]  TeamCoordinator (roomOf, isGuestSession)
 * @param {object} opts.extras  ExtrasStore (getProjectInstructions)
 */
export function createProjectInstructions({ lens, team, extras, logger = console }) {
  const warned = new Set();
  return {
    /** The appendSystemContext text for a turn, or undefined. */
    forTurn(ctx) {
      const key = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey : '';
      try {
        if (!key) return undefined;
        const chat = lens.rootOf(key);
        if (!chat || team?.isGuestSession(chat)) return undefined;
        const room = team?.roomOf(chat) || null;
        const project = lens.categoryOf(room || chat);
        if (!project) return undefined;
        const found = extras.getProjectInstructions(project);
        if (!found || (room && !found.shared)) return undefined;
        return formatInstructions(project, found.text);
      } catch (e) {
        if (!warned.has(key)) { warned.add(key); logger.warn?.(`[instructions] skipped for ${key}: ${e.message}`); }
        return undefined;
      }
    },
  };
}

// File paths a reader would open: ~/…, /abs/… (two segments or more), ./… and ../…, plus `relative/paths.ext` or
// `relative/dirs/` in backticks (bare a/b words such as "client/server" or `origin/main` aren't paths).
const UNQUOTED = /(?:^|[\s(\[<"'])((?:~\/|\.\.?\/|\/[^\s/`'"()<>]+\/)[^\s`'"()<>]*)/g;
const QUOTED = /`([^`\s]+)`/g;
const SKIP = /[<>*{}$|]|:\/\//;

export function pathsIn(text) {
  const out = new Set();
  const add = (raw) => {
    const p = String(raw).replace(/[.,:;!?)\]]+$/, '').replace(/:\d+(?::\d+)?$/, '');
    if (!p || SKIP.test(p) || p === '~/' || p.length >= 400) return;
    if (p.startsWith('/') && p.split('/').filter(Boolean).length < 2) return; // "/next/", "/approve": URL paths, commands
    out.add(p);
  };
  for (const m of String(text || '').matchAll(UNQUOTED)) add(m[1]);
  for (const m of String(text || '').matchAll(QUOTED)) {
    const t = m[1];
    if (/^(?:~\/|\.\.?\/|\/)/.test(t)) add(t);
    else if (t.includes('/') && (/\.[A-Za-z0-9]{1,8}$/.test(t) || t.endsWith('/'))) add(t);
  }
  return [...out];
}

/** Paths in the text that don't exist on this machine (relative ones resolve against the agent workspace). */
export function missingPaths(text, { workspaceDir = null, home = os.homedir(), exists = fs.existsSync } = {}) {
  const missing = [];
  for (const p of pathsIn(text)) {
    let abs;
    if (p.startsWith('~/')) abs = path.join(home, p.slice(2));
    else if (p.startsWith('/')) abs = p;
    else if (workspaceDir) abs = path.resolve(workspaceDir, p);
    else continue;
    if (!exists(abs)) missing.push(p);
    if (missing.length >= 20) break;
  }
  return missing;
}

/** Register the hook when the gateway allows it; `get()` returns the live instructions source once the app runs. */
export function registerProjectInstructions(api, pluginId, get) {
  const state = instructionsState(api.config, pluginId);
  if (state === 'active' && typeof api.on === 'function') {
    api.on('before_prompt_build', (_event, ctx) => {
      const text = get()?.forTurn(ctx);
      return text ? { appendSystemContext: text } : undefined;
    }, { name: 'project-instructions' });
  }
  return state;
}
