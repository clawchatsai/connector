// Chat tags: pure helpers behind the tagger (tagger.js). No I/O.
//
// A chat's tags are a few broad subjects (`proxmox`, `laser-show`) shared across chats, so they can
// be browsed (#proxmox in search). A tag is lowercase words joined by hyphens: one token to type
// and click, while the index still finds it by each word. The model is shown the tags already in
// use and asked to reuse them; normalizeTag() folds what it still gets wrong (case, '#', spaces,
// a plural of an existing tag) and the user's renames and deletions (aliases).

export const MAX_TAGS = 5;
export const MAX_TAG_CHARS = 32;
export const MAX_KEYWORDS = 10;
export const MAX_SUMMARY_CHARS = 200;
const MAX_TAG_WORDS = 3;
const PROMPT_CHARS = 12_000;      // conversation text sent per chat
const MESSAGE_CHARS = 600;        // per message
const HEAD_MESSAGES = 4;          // always sent: how the chat started
const VOCABULARY_SHOWN = 80;

// Says nothing about a chat's subject.
const NOISE = new Set(['chat', 'chats', 'conversation', 'discussion', 'question', 'questions', 'help', 'request', 'task', 'tasks',
  'misc', 'other', 'general', 'user', 'assistant', 'ai', 'update', 'issue', 'info', 'test']);

export const SYSTEM_PROMPT = 'You label chat conversations so their owner can find them again later. Reply with one JSON object and nothing else.';

/**
 * Raw tag → canonical form, or '' when it carries nothing. `vocabulary` (Set of tags in use) maps a
 * plural or singular variant onto the existing tag; `aliases` (Map tag → target, '' = deleted) applies
 * the user's renames and deletions.
 */
export function normalizeTag(raw, { vocabulary = null, aliases = null } = {}) {
  let t = String(raw ?? '').normalize('NFKC').toLowerCase().replace(/^#+/, '')
    .replace(/[_\s/]+/g, '-').replace(/[^\p{L}\p{N}+.#-]/gu, '').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!t || t.split('-').length > MAX_TAG_WORDS || t.length > MAX_TAG_CHARS || NOISE.has(t) || !/\p{L}/u.test(t)) return '';
  if (vocabulary && !vocabulary.has(t)) {
    if (t.endsWith('s') && vocabulary.has(t.slice(0, -1))) t = t.slice(0, -1);
    else if (vocabulary.has(`${t}s`)) t = `${t}s`;
  }
  for (let hops = 0; aliases?.has(t) && hops < 10; hops++) t = aliases.get(t);
  return t;
}

/** Distinct normalized tags, in order, at most `max`. */
export function normalizeTags(list, opts = {}, max = MAX_TAGS) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = normalizeTag(raw, opts);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The conversation as the model sees it: how it started (first HEAD_MESSAGES messages) and as much
 * of the latest part as fits, each message capped. `messages`: [{ role, kind, text, quote }] oldest first.
 */
export function condense(messages, budget = PROMPT_CHARS) {
  const line = m => {
    const who = m.kind === 'comment' ? 'User comment' : m.role === 'user' ? 'User' : 'AI';
    const quote = m.kind === 'comment' && m.quote ? ` (on "${oneLine(m.quote, 160)}")` : '';
    return `${who}${quote}: ${oneLine(m.text, MESSAGE_CHARS)}`;
  };
  const lines = messages.filter(m => m?.text?.trim()).map(line);
  const head = lines.slice(0, HEAD_MESSAGES);
  let used = head.reduce((n, l) => n + l.length + 2, 0);
  const tail = [];
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (used + lines[i].length + 2 > budget) break;
    tail.unshift(lines[i]);
    used += lines[i].length + 2;
  }
  const skipped = lines.length - head.length - tail.length;
  return [...head, ...(skipped > 0 ? [`[… ${skipped} messages left out …]`] : []), ...tail].join('\n\n');
}

/** The user message for one chat. `vocabulary`: tags in use, most used first. */
export function buildPrompt({ title, conversation, vocabulary = [] }) {
  const known = vocabulary.slice(0, VOCABULARY_SHOWN);
  return `${known.length ? `Tags already in use (reuse one whenever it fits; add a new tag only when none does): ${known.join(', ')}\n\n` : ''}Chat title: ${title || '(none)'}

Conversation:
${conversation}

Return exactly: {"summary": "...", "tags": ["..."], "keywords": ["..."]}
- summary: one sentence, at most 160 characters, saying what was done or decided and how it ended. In the conversation's language. Don't start with "The user".
- tags: 1 to ${MAX_TAGS} broad subjects someone would browse by (a project, product, system, field or kind of work), lowercase, 1 to 3 words joined by hyphens, singular. Never generic words like chat, help, question.
- keywords: up to ${MAX_KEYWORDS} specific names someone might search for: hosts, files, people, products, error codes, commands.`;
}

/**
 * The model's reply → { summary, tags, keywords } (normalized), or throws when it holds no usable
 * JSON object. Tolerates code fences and prose around the object.
 */
export function parseReply(text, opts = {}) {
  const s = String(text ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('reply had no JSON object');
  let obj;
  try { obj = JSON.parse(body.slice(start, end + 1)); } catch { throw new Error('reply JSON did not parse'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('reply was not an object');
  const summary = oneLine(obj.summary, MAX_SUMMARY_CHARS);
  const tags = normalizeTags(obj.tags, opts);
  const keywords = [...new Set((Array.isArray(obj.keywords) ? obj.keywords : []).map(k => oneLine(k, 60)).filter(Boolean))].slice(0, MAX_KEYWORDS);
  if (!summary && !tags.length) throw new Error('reply had neither a summary nor tags');
  return { summary, tags, keywords };
}

/** A chat's tags as shown: the model's, minus the ones the user removed, plus the ones they added. */
export function effectiveTags({ auto = [], added = [], removed = [] }) {
  const out = auto.filter(t => !removed.includes(t));
  for (const t of added) if (!out.includes(t)) out.push(t);
  return out;
}

// Per million tokens, for the backfill estimate before any chat was tagged (afterwards: measured cost).
const PRICES = { 'claude-haiku-4-5': { input: 1, output: 5 } };

/**
 * The owner's model for tags from the gateway config (plugins.entries.<pluginId>.config.tags.model), or null.
 * Any model ref the gateway resolves: `provider/model`, or one of its aliases (`haiku`).
 */
export function tagsModelFromConfig(cfg, pluginId) {
  const model = cfg?.plugins?.entries?.[pluginId]?.config?.tags?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

/** Whether `model` runs on a CLI subscription (no per-token price). */
export const isSubscription = model => /^claude-cli\//.test(String(model || ''));

/** Estimated USD for tagging chats of these sizes (characters of conversation each) on `model`, or null. */
export function estimateCost(chatChars, model) {
  if (isSubscription(model)) return null;
  const price = Object.entries(PRICES).find(([id]) => String(model || '').includes(id))?.[1];
  if (!price) return null;
  const input = chatChars.reduce((n, c) => n + Math.min(c, PROMPT_CHARS) / 4 + 700, 0);
  return (input * price.input + chatChars.length * 250 * price.output) / 1e6;
}
