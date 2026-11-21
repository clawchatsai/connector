// Progress-card reminder for CLI-runtime chats (claude-cli and the other *-cli backends).
//
// OpenClaw tells the agent about its progress_card tool only on embedded-runner turns
// (src/agents/embedded-agent-runner/run/attempt-system-prompt-additions.ts); CLI runtimes never get that line, so a
// claude-cli agent almost never makes a card (0 of 5 multi-step runs, 5 of 5 with this reminder). This adds the line
// through a before_prompt_build hook. The gateway lets a non-bundled plugin register that hook only with
// plugins.entries.connector.hooks.allowConversationAccess: true (README → "Progress cards in claude-cli chats").
// Upstream gap: clawchats known-gaps/progress-card-cli-reminder.md. Remove this module once OpenClaw adds the
// reminder on CLI runtimes too.

export const PROGRESS_CARD_REMINDER = 'Progress cards: this chat client shows a task progress card above the message box. For substantial work with at least two meaningful sequential steps (never greetings, quick questions or single-step requests), call the OpenClaw `progress_card` tool before starting, and again as steps change. If it is not loaded, look it up first with your tool search (it is mcp__openclaw__progress_card). Its only inputs are `plan`: an array of {step: string, status: "pending" | "in_progress" | "completed"} with at most one in_progress, and an optional `markdown` note. Each call replaces the whole card; mark finished steps completed.';

// Before this release a claude-cli agent can't save a card: on 2026.9.7 every progress_card call fails in the gateway
// ("Gateway client authority closed before dispatching progressCard.put."). 2026.11.6 is the first verified to work.
export const MIN_GATEWAY_VERSION = [2026, 11, 6];

const versionAtLeast = (version, min) => {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (Number(v[i + 1]) !== min[i]) return Number(v[i + 1]) > min[i];
  return true;
};

/**
 * 'active': the hook is registered. 'blocked': the gateway refuses it until allowConversationAccess is true.
 * 'off': progress cards (tools.updatePlan) or prompt hooks (allowPromptInjection) are turned off on purpose.
 * 'unsupported': a gateway older than MIN_GATEWAY_VERSION (or of unknown version), where the reminder would only
 * produce failing tool calls.
 */
export function progressReminderState(cfg, pluginId, gatewayVersion) {
  if (!versionAtLeast(gatewayVersion, MIN_GATEWAY_VERSION)) return 'unsupported';
  if (cfg?.tools?.updatePlan === false) return 'off';
  const hooks = cfg?.plugins?.entries?.[pluginId]?.hooks;
  if (hooks?.allowPromptInjection === false) return 'off';
  return hooks?.allowConversationAccess === true ? 'active' : 'blocked';
}

/** A CLI-runtime turn outside the agent's main session and subagents (the turns OpenClaw itself would remind). */
export function wantsProgressReminder(ctx, cfg) {
  if (!String(ctx?.modelProviderId ?? '').trim().toLowerCase().endsWith('-cli')) return false;
  const rest = /^agent:[^:]+:(.+)$/i.exec(String(ctx?.sessionKey ?? '').trim())?.[1]?.toLowerCase();
  if (!rest) return false;
  if (rest === String(cfg?.session?.mainKey || 'main').trim().toLowerCase()) return false;
  return !/(^|:)subagent:/.test(rest);
}

export const blockedLogLine = pluginId => 'Progress cards: claude-cli chats get no progress-card reminder because the gateway blocks the '
  + `connector's before_prompt_build hook. To turn it on, set plugins.entries.${pluginId}.hooks.allowConversationAccess `
  + 'to true (it lets the connector\'s prompt hooks read conversation content); see the connector README, "Progress cards in claude-cli chats".';

/** Register the hook when the gateway allows it; returns the state for /api/health and the startup log. */
export function registerProgressReminder(api, pluginId) {
  let version;
  try { version = api.runtime?.version; } catch { /* CLI-metadata registration: runtime access throws; no hooks there */ }
  const state = progressReminderState(api.config, pluginId, version);
  if (state === 'active' && typeof api.on === 'function') {
    api.on('before_prompt_build', (_event, ctx) => (wantsProgressReminder(ctx, api.config)
      ? { appendSystemContext: PROGRESS_CARD_REMINDER }
      : undefined), { name: 'progress-card-cli-reminder' });
  }
  return state;
}
