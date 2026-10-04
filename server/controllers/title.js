import { send, sendError, parseBody } from '../util/http.js';

// Chat-title fallback on the gateway's main model. ClawChats first asks the gateway's own
// titler (sessions.title.prepare), which only runs a utility model and returns null when the
// gateway has none (e.g. a claude-cli main model). The gateway's first-message titler falls
// back to the main model in that case; this endpoint does the same through the plugin's
// host-run completion (api.runtime.llm.complete), with the gateway's own title prompt.
export const TITLE_PROMPT = "Generate a concise session title (3-6 words, max 60 characters) from the user's first message. Use the same language as the message, in sentence case: capitalize only the first word and words that language always capitalizes. No emoji. Return only the title.";
const TITLE_MAX_CHARS = 60;
const SOURCE_MAX_CHARS = 1000;
const TIMEOUT_MS = 60_000;

// Port of the gateway's normalizeDashboardSessionTitle (src/gateway/dashboard-session-title.ts).
export function normalizeTitle(raw) {
  const firstLine = String(raw || '').replace(/\r/g, '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('```'));
  if (!firstLine) return null;
  const normalized = firstLine.replace(/^\s*(?:title\s*:\s*)?/i, '').replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  return normalized ? Array.from(normalized).slice(0, TITLE_MAX_CHARS).join('') : null;
}

/**
 * @param {{ complete?: (params: object) => Promise<{ text?: string }> }} llm  api.runtime.llm
 */
export function createTitleHandler(llm) {
  // Direct completion where the main model's provider has a direct transport; CLI and harness
  // runtimes (claude-cli, codex, …) only run in isolated agent-runtime mode.
  async function complete(message) {
    const base = { messages: [{ role: 'user', content: message }], systemPrompt: TITLE_PROMPT, purpose: 'clawchats.title', maxTokens: 64 };
    try {
      return await llm.complete(base);
    } catch (err) {
      if (err?.code === 'LLM_COMPLETION_NOT_AUTHORIZED') throw err;
      return await llm.complete({ ...base, maxTokens: undefined, execution: { mode: 'isolated-agent-runtime', timeoutMs: TIMEOUT_MS } });
    }
  }

  return async function handleTitle(req, res) {
    if (typeof llm?.complete !== 'function') return sendError(res, 501, 'This OpenClaw version has no plugin model completion');
    const { message } = await parseBody(req);
    if (typeof message !== 'string' || !message.trim()) return sendError(res, 400, 'Missing message');
    const result = await complete(Array.from(message.trim()).slice(0, SOURCE_MAX_CHARS).join(''));
    return send(res, 200, { title: normalizeTitle(result?.text), model: result?.provider && result?.model ? `${result.provider}/${result.model}` : undefined });
  };
}
