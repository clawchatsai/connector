// Chat links: the `clawchats_link` and `clawchats_messages` agent tools and where links open. A link names one chat on
// this gateway, `<app base>?gateway=<gatewayId>&session=<sessionKey>`, optionally one message in it (`&message=<entry id>`,
// the gateway transcript's own id). The ClawChats app reads it: clawchats frontend/data/chat-links.js, spec clawchats
// specs/chat-links.md. It carries no credentials: it opens only for someone signed in to this gateway.
//
// Message ids are never guessed. "This" message is the turn being written: the first assistant entry after the newest
// user message. The gateway writes an assistant message, tool calls included, before it runs them, and a chat runs one
// turn at a time, so that entry exists and belongs to this reply when the tool runs. (Not matched by tool call id: a call
// made through Tool Search is stored under the dispatch call's id, and other runtimes wrap ids too.) Any other id is
// checked against the transcript.
//
// The app base is where the owner's ClawChats is served (app.clawchats.ai, next.clawchats.ai, a staging slot): each
// browser reports it on connect (PUT /api/app-base) and the last one wins, so agents' links open where the owner works.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_APP_BASE = 'https://app.clawchats.ai/';
const MAX = 300;

const MSG_PAGE = 100;      // transcript entries per chat.history page
const MSG_PAGES = 10;      // how far back an id is looked up (the app pages back as far to show it)
const THIS_TRIES = 5;      // the reply's first entry may land a moment after the call starts
const THIS_WAIT_MS = 200;

const DESCRIPTION = [
  'Link to a chat in ClawChats, the app your user reads you in, or to one message in it. Use it whenever you send the user a',
  'link to a chat (a report, a summary, a message on another channel). clawchats_link() links this chat;',
  'clawchats_link({ message: "this" }) links the reply you are writing now (call it from that reply);',
  'clawchats_link({ sessionKey, messageId }) links another chat or an earlier message (ids from clawchats_messages).',
  'Returns { url, messageId? }. Never build or edit the URL yourself. It opens only for someone signed in to this gateway in',
  'ClawChats; it shares nothing.',
].join(' ');

const PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    sessionKey: { type: 'string', maxLength: MAX, description: 'The chat\'s session key (agent:<id>:…); default: this chat' },
    message: { type: 'string', enum: ['this'], description: '"this": link the reply you are writing now (this chat only)' },
    messageId: { type: 'string', maxLength: MAX, description: 'A message id from clawchats_messages' },
  },
};

const MESSAGES_DESCRIPTION = [
  'The recent messages of a ClawChats chat on this gateway, newest last, each with its id, role, time and first line, so you',
  'can link one with clawchats_link({ sessionKey, messageId }). Default: this chat, 20 messages.',
].join(' ');

const MESSAGES_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    sessionKey: { type: 'string', maxLength: MAX, description: 'The chat\'s session key; default: this chat' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many messages (default 20, max 50)' },
  },
};

const badKey = k => !k || k.length > MAX || /[\u0000-\u001f]/.test(k);

/** The transcript's own id of a chat.history message (`__openclaw.id`; any `__*` meta object with an id). */
export function entryId(m) {
  if (!m || typeof m !== 'object') return null;
  for (const [k, v] of Object.entries(m)) if (k.startsWith('__') && v && typeof v === 'object' && typeof v.id === 'string') return v.id;
  return null;
}

const blocks = m => (Array.isArray(m?.content) ? m.content : []);
const textOf = m => typeof m?.content === 'string' ? m.content : blocks(m).filter(b => b?.type === 'text').map(b => b.text || '').join('\n');
/** The turn being written in `messages` (chronological): its first assistant entry after the newest user message, or null. */
export function currentTurnEntry(messages) {
  let first = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return first;
    if (m?.role === 'assistant' && entryId(m)) first = m;
  }
  return null; // the turn started before this page: no user message to anchor it
}

/** A message as clawchats_messages shows it: user and assistant messages with text. */
export function messageSummary(m) {
  if (m?.role !== 'user' && m?.role !== 'assistant') return null;
  const id = entryId(m), text = textOf(m).trim();
  if (!id || !text) return null;
  const line = text.split('\n').find(l => l.trim())?.trim() || '';
  return { id, role: m.role, time: m.timestamp ? new Date(m.timestamp).toISOString() : null, text: line.length > 160 ? line.slice(0, 159) + '…' : line };
}

/** An app base the browser may report: https (http only on localhost), a path ending in /, no query or hash. */
export function validBase(value) {
  if (typeof value !== 'string' || !value || value.length > MAX) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return null;
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) return null;
  return url.toString();
}

/** The link that opens a chat (and a message in it); `gatewayId` may be empty (then the reader's connected gateway). */
export function chatLink(base, gatewayId, sessionKey, messageId = null) {
  const url = new URL(base);
  if (gatewayId) url.searchParams.set('gateway', gatewayId);
  url.searchParams.set('session', sessionKey);
  if (messageId) url.searchParams.set('message', messageId);
  return url.toString();
}

/**
 * Links for this gateway: the reported app base (kept in <dataDir>/app-base.json), link() for clawchats_link and
 * messages() for clawchats_messages. `sessionExists(key)` → true | false | null (can't tell); `history(key, { limit,
 * offset })` → a chat.history page ({ messages, hasMore, nextOffset }).
 */
export function createChatLinks({ dataDir, gatewayId = () => '', sessionExists = async () => null, history = null, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const file = path.join(dataDir, 'app-base.json');
  let base = null;
  try { base = validBase(JSON.parse(fs.readFileSync(file, 'utf8')).base); } catch { /* none yet */ }

  /** Newest-first walk over a chat's transcript pages; `find(m)` true stops it. Returns the message or null. */
  async function findEntry(key, find, pages = MSG_PAGES) {
    let offset;
    for (let i = 0; i < pages; i++) {
      const page = await history(key, { limit: MSG_PAGE, ...(offset != null ? { offset } : {}) });
      const hit = [...(page?.messages || [])].reverse().find(find);
      if (hit) return hit;
      if (!page?.hasMore || !Number.isFinite(page.nextOffset)) return null;
      offset = page.nextOffset;
    }
    return null;
  }

  return {
    base: () => base || DEFAULT_APP_BASE,
    /** A browser's report. False when it isn't an app base. */
    setBase(value) {
      const v = validBase(value);
      if (!v) return false;
      if (v !== base) {
        base = v;
        try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ base: v })); } catch { /* kept in memory */ }
      }
      return true;
    },
    /**
     * { url, gatewayId, sessionKey, messageId? } or { error }: an unknown chat or message fails loudly instead of
     * making a dead link. `thisTurn`: link the reply being written in `sessionKey` (message "this").
     */
    async link(sessionKey, { messageId = null, thisTurn = false } = {}) {
      const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
      if (badKey(key)) return { error: 'sessionKey must be a session key like agent:main:…' };
      if (await sessionExists(key) === false) return { error: `No chat ${key} on this gateway` };
      let msg = null;
      if (thisTurn || messageId) {
        if (!history) return { error: 'Message links need the gateway transcript, which this connector cannot read right now' };
        if (messageId && (typeof messageId !== 'string' || badKey(messageId))) return { error: 'messageId must be an id from clawchats_messages' };
        try {
          if (thisTurn) {
            for (let i = 0; i < THIS_TRIES && !msg; i++) {
              if (i) await wait(THIS_WAIT_MS);
              msg = currentTurnEntry((await history(key, { limit: MSG_PAGE }))?.messages || []);
            }
            if (!msg) return { error: 'Your reply is not in the transcript yet; call clawchats_link({ message: "this" }) again from the same reply' };
          } else {
            msg = await findEntry(key, m => entryId(m) === messageId);
            if (!msg) return { error: `No message ${messageId} in ${key} (looked back ${MSG_PAGE * MSG_PAGES} entries)` };
          }
        } catch (e) { return { error: `Could not read ${key}: ${e?.message || e}` }; }
      }
      const gw = gatewayId() || '';
      const id = msg ? entryId(msg) : null;
      return { url: chatLink(this.base(), gw, key, id), gatewayId: gw || null, sessionKey: key, ...(id ? { messageId: id } : {}) };
    },
    /** The last `limit` user/assistant messages with text, newest last: { sessionKey, messages } or { error }. */
    async messages(sessionKey, limit = 20) {
      const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
      if (badKey(key)) return { error: 'sessionKey must be a session key like agent:main:…' };
      if (!history) return { error: 'This connector cannot read the gateway transcript right now' };
      const n = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 20));
      try {
        const page = await history(key, { limit: Math.min(MSG_PAGE, n * 4) });
        const list = (page?.messages || []).map(messageSummary).filter(Boolean).slice(-n);
        return { sessionKey: key, messages: list };
      } catch (e) { return { error: `Could not read ${key}: ${e?.message || e}` }; }
    },
  };
}

const result = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], details: obj });

/** The tool descriptors (plugin tool factory v2). Not offered to other people's turns (guests, contact copies). */
export function chatLinkTool(getLinks) {
  return {
    contextVersion: 2,
    create(context) {
      if (context?.senderIsOwner === false) return null;
      return {
        name: 'clawchats_link',
        label: 'ClawChats link',
        description: DESCRIPTION,
        parameters: PARAMETERS,
        async execute(_id, params) {
          const links = getLinks();
          if (!links) return result({ error: 'ClawChats is still starting on this gateway; try again in a moment' });
          const key = params?.sessionKey ?? context?.sessionKey;
          if (params?.message === 'this') {
            if (params?.messageId) return result({ error: 'Give message: "this" or messageId, not both' });
            if (key !== context?.sessionKey) return result({ error: 'message: "this" links your reply in this chat; leave sessionKey out' });
            return result(await links.link(key, { thisTurn: true }));
          }
          return result(await links.link(key, { messageId: params?.messageId || null }));
        },
      };
    },
  };
}

export function chatMessagesTool(getLinks) {
  return {
    contextVersion: 2,
    create(context) {
      if (context?.senderIsOwner === false) return null;
      return {
        name: 'clawchats_messages',
        label: 'ClawChats messages',
        description: MESSAGES_DESCRIPTION,
        parameters: MESSAGES_PARAMETERS,
        async execute(_id, params) {
          const links = getLinks();
          if (!links) return result({ error: 'ClawChats is still starting on this gateway; try again in a moment' });
          return result(await links.messages(params?.sessionKey ?? context?.sessionKey, params?.limit));
        },
      };
    },
  };
}

/** Register `clawchats_link` and `clawchats_messages`; `getLinks()` is the running app's createChatLinks (null until it starts). */
export function registerChatLink(api, getLinks) {
  if (typeof api.registerTool !== 'function') return;
  api.registerTool(chatLinkTool(getLinks), { name: 'clawchats_link' });
  api.registerTool(chatMessagesTool(getLinks), { name: 'clawchats_messages' });
}
