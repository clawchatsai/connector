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
 * A host-run completion (api.runtime.llm.complete): direct where the model's provider has a direct
 * transport; CLI and harness runtimes (claude-cli, codex, …) only run in isolated agent-runtime mode.
 * `model` pins a model (needs plugins.entries.connector.llm.allowModelOverride); omitted = the host's default.
 * @param {{ complete?: (params: object) => Promise<{ text?: string }> }} llm  api.runtime.llm
 * @param {{ systemPrompt: string, purpose: string, maxTokens?: number }} o
 */
export function createCompletion(llm, { systemPrompt, purpose, maxTokens }) {
  return async function complete(message, { model } = {}) {
    const base = { messages: [{ role: 'user', content: message }], systemPrompt, purpose, maxTokens, ...(model ? { model } : {}) };
    try {
      const result = await llm.complete(base);
      // The host resolves rather than throws when every credential for the direct transport failed (no API
      // key, an unreachable provider URL): a CLI-runtime gateway still answers in isolated mode.
      if (result?.stopReason !== 'error') return result;
    } catch (err) {
      // Not a transport problem: isolated mode fails the same way. LLM_RUNTIME_LIFECYCLE (2026.11.5+): the plugin or
      // model runtime is reloading; the host says to retry from a fresh plugin operation, not inside this one.
      // 2026.11.6 reports a retired runtime (plugin reload) by message only.
      if (['LLM_COMPLETION_NOT_AUTHORIZED', 'LLM_RUNTIME_LIFECYCLE', 'LLM_COMPLETION_ABORTED'].includes(err?.code) || /runtime is no longer active/i.test(err?.message || '')) throw err;
    }
    return await llm.complete({ ...base, maxTokens: undefined, execution: { mode: 'isolated-agent-runtime', timeoutMs: TIMEOUT_MS } });
  };
}

const titleCompletion = llm => createCompletion(llm, { systemPrompt: TITLE_PROMPT, purpose: 'clawchats.title', maxTokens: 64 });

/** message → title or null (null also when the host has no plugin model completion). */
export function createTitler(llm) {
  const complete = titleCompletion(llm);
  return async message => {
    if (typeof llm?.complete !== 'function' || typeof message !== 'string' || !message.trim()) return null;
    return normalizeTitle((await complete(Array.from(message.trim()).slice(0, SOURCE_MAX_CHARS).join('')))?.text);
  };
}

/**
 * @param {{ complete?: (params: object) => Promise<{ text?: string }> }} llm  api.runtime.llm
 */
export function createTitleHandler(llm) {
  const complete = titleCompletion(llm);

  return async function handleTitle(req, res) {
    if (typeof llm?.complete !== 'function') return sendError(res, 501, 'This OpenClaw version has no plugin model completion');
    const { message } = await parseBody(req);
    if (typeof message !== 'string' || !message.trim()) return sendError(res, 400, 'Missing message');
    const source = Array.from(message.trim()).slice(0, SOURCE_MAX_CHARS).join('');
    let result;
    try {
      result = await complete(source);
    } catch (err) {
      console.warn(`[title] completion failed (source ${source.length} chars): ${err?.code || ''} ${err?.stack || err}`);
      throw err;
    }
    const title = normalizeTitle(result?.text);
    // The reason a retitle comes back empty: which model answered, and what it actually returned.
    if (!title) console.warn(`[title] no title from ${result?.provider}/${result?.model} (source ${source.length} chars, reply ${JSON.stringify(String(result?.text ?? '').slice(0, 200))}, keys ${Object.keys(result || {}).join(',')})`);
    return send(res, 200, { title, model: result?.provider && result?.model ? `${result.provider}/${result.model}` : undefined });
  };
}
