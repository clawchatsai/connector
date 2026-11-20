// Search documents from gateway history entries (chat.history / chat.message.get), and the
// selection-comment attachment format. Pure functions; the indexer (indexer.js) does the I/O.
//
// What is searchable is what the chat shows as text: user and assistant text blocks. Tool calls,
// tool results and thinking stay out, as in the gateway's own transcript index. Selection comments
// travel as `selection-comment.txt` attachments on a (usually empty) user message, so their text is
// only in the inbound media store; each comment becomes its own document on that message.

export const MAX_DOC_CHARS = 200_000;
// Room transcripts of team chats prefix every entry with its author (server/team.js).
const TEAM_LABEL_PREFIX = /^\[([^\]\n]{1,100})\]\n\n/;
// Reply directives the gateway strips before showing a reply (Control UI / ClawChats alike).
const DIRECTIVES = /\[\[\s*(?:reply_to_current|reply_to\s*:[^\]]*|audio_as_voice)\s*\]\]/g;
const COMMENT_FILE = /^selection-comment\.txt$/i;
const INBOUND_URL = /^media:\/\/inbound\/[^/?#\\]+$/;

/** The gateway's transcript metadata on an entry (`__<platform>`, found by shape, as the browser does). */
export function entryMeta(m) {
  if (!m || typeof m !== 'object') return null;
  for (const k of Object.keys(m)) {
    if (k.startsWith('__') && m[k] && typeof m[k] === 'object' && !Array.isArray(m[k]) && typeof m[k].id === 'string') return { field: k, meta: m[k] };
  }
  return null;
}

export function textOf(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  return '';
}

function clean(text) {
  return String(text || '').replace(DIRECTIVES, ' ').replace(/[ \t]+\n/g, '\n').trim().slice(0, MAX_DOC_CHARS);
}

function timestampOf(m) {
  const t = typeof m?.timestamp === 'number' ? m.timestamp : Date.parse(m?.timestamp);
  return Number.isFinite(t) ? t : null;
}

/** Inbound `selection-comment.txt` attachments of an entry: [{ url }] in attachment order. */
export function commentAttachments(m) {
  const media = entryMeta(m)?.meta?.media;
  if (!Array.isArray(media)) return [];
  return media.filter(x => x && typeof x.url === 'string' && INBOUND_URL.test(x.url) && COMMENT_FILE.test(x.fileName || '')).map(x => ({ url: x.url }));
}

/**
 * Parse a selection-comment body (frontend/chat/selection-comments.js formatSelectionComment, the
 * Control UI's format). The quoted passage is cut by its declared UTF-16 length, so a passage that
 * itself contains "User comment:" can't be misread. Returns { quote, comment } or null.
 */
export function parseSelectionComment(body) {
  if (typeof body !== 'string' || !body.startsWith('Selected text:\n')) return null;
  const head = 'Selected text:\n';
  const tailAt = body.lastIndexOf('\n\nSource session: ');
  if (tailAt < 0) return null;
  const len = /\nSelected text UTF-16 length: (\d+)/.exec(body.slice(tailAt));
  let quote, rest;
  if (len && head.length + Number(len[1]) <= tailAt) {
    quote = body.slice(head.length, head.length + Number(len[1]));
    rest = body.slice(head.length + quote.length, tailAt);
  } else {
    // No usable length: split at the first comment marker.
    const at = body.indexOf('\n\nUser comment:\n', head.length);
    quote = body.slice(head.length, at >= 0 && at < tailAt ? at : tailAt);
    rest = body.slice(head.length + quote.length, tailAt);
  }
  const comment = rest.startsWith('\n\nUser comment:\n') ? rest.slice('\n\nUser comment:\n'.length) : '';
  return { quote: clean(quote), comment: clean(comment) };
}

/**
 * Who wrote a room entry, from the room's author map (team store): 'user' (the owner), 'person'
 * (someone else in the room), 'assistant' (an agent) or null for timeline lines ("Kamil joined").
 */
function teamRole(author, label) {
  if (author?.type === 'system' || (!author && label === 'System')) return null;
  if (author?.type === 'user') return 'user';
  if (author?.type === 'person') return 'person';
  return 'assistant';
}

/**
 * Documents for one history entry. `team` (room author map) switches to room parsing: entries are
 * assistant-role injections prefixed with "[Label]\n\n" and attributed through the map.
 * Returns { id, ts, truncated, docs: [{ kind: 'message', role, text }], comments: [{ url }] }, or
 * null for entries with nothing searchable and no id.
 */
export function documentsOf(m, { team = null } = {}) {
  const em = entryMeta(m);
  const id = em?.meta.id;
  if (!id || (m.role !== 'user' && m.role !== 'assistant')) return null;
  const ts = timestampOf(m);
  const truncated = em.meta.truncated === true || em.meta.truncated === 'true';
  let role = m.role;
  let text = textOf(m);
  if (team) {
    if (m.role !== 'assistant') return null;
    const match = TEAM_LABEL_PREFIX.exec(text);
    role = teamRole(team[id], match?.[1]);
    if (!role) return null;
    if (match) text = text.slice(match[0].length);
  }
  text = clean(text);
  const docs = text ? [{ kind: 'message', role, text }] : [];
  const comments = m.role === 'user' ? commentAttachments(m) : [];
  if (!docs.length && !comments.length && !truncated) return null;
  return { id, ts, truncated, docs, comments };
}
