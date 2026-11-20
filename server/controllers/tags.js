// Chat tags and summaries (server/tags/). 503 when the tagger isn't running (no search index).
//
//   GET  /api/tags                         { status, vocabulary: [{ tag, count }], chats: { [key]: { tags, summary } } }
//   PATCH /api/tags/chat   { key, add?, remove? }   the user's edit of one chat's tags → { chat }
//   POST /api/tags/retag   { key }                  tag this chat again now
//   POST /api/tags/rename  { from, to }             everywhere; a merge when `to` is in use
//   POST /api/tags/delete  { tag }                  from every chat, and the model won't use it again
//   POST /api/tags/settings { enabled?, backfill?: 'accepted'|'declined' }

import { send, sendError, parseBody } from '../util/http.js';
import { normalizeTag } from '../tags/model.js';

const strings = v => (Array.isArray(v) ? v : []).filter(t => typeof t === 'string').slice(0, 20);

export function createTagHandlers({ tags, tagger, search }) {
  const unavailable = res => sendError(res, 503, 'Tags unavailable: the search index is off');

  /** After a change to stored rows: the index copy and every browser follow. */
  function changed(keys) {
    for (const key of keys) {
      const row = tags.get(key);
      if (row) search.setMeta(key, { tags: row.tags, summary: row.summary, keywords: row.keywords });
      tagger.announce(key, row);
    }
  }

  function handleList(req, res) {
    if (!tagger) return unavailable(res);
    const chats = {};
    for (const r of tags.all()) if (r.tags.length || r.summary) chats[r.key] = { tags: r.tags, summary: r.summary };
    return send(res, 200, { status: tagger.status(), vocabulary: tags.vocabulary(), chats });
  }

  async function handleEdit(req, res) {
    if (!tagger) return unavailable(res);
    const { key, add, remove } = await parseBody(req);
    if (typeof key !== 'string' || !search.getChat(key)) return sendError(res, 409, 'That chat isn\'t in the search index yet');
    const chat = tags.edit(key, { add: strings(add), remove: strings(remove) });
    changed([key]);
    return send(res, 200, { chat: { key, tags: chat.tags, summary: chat.summary } });
  }

  async function handleRetag(req, res) {
    if (!tagger) return unavailable(res);
    const { key } = await parseBody(req);
    try { tagger.retag(String(key || '')); }
    catch (e) { return sendError(res, e.status || 500, e.message); }
    return send(res, 202, { status: tagger.status() });
  }

  async function handleRename(req, res) {
    if (!tagger) return unavailable(res);
    const body = await parseBody(req);
    const from = normalizeTag(body.from), to = normalizeTag(body.to);
    if (!from || !to) return sendError(res, 400, 'A tag is lowercase words joined by hyphens, at most 32 characters');
    if (from === to) return send(res, 200, { changed: 0 });
    const keys = tags.renameTag(from, to);
    changed(keys);
    return send(res, 200, { changed: keys.length });
  }

  async function handleDelete(req, res) {
    if (!tagger) return unavailable(res);
    const tag = normalizeTag((await parseBody(req)).tag);
    if (!tag) return sendError(res, 400, 'Missing tag');
    const keys = tags.renameTag(tag, '');
    changed(keys);
    return send(res, 200, { changed: keys.length });
  }

  async function handleSettings(req, res) {
    if (!tagger) return unavailable(res);
    const { enabled, backfill } = await parseBody(req);
    if (typeof enabled === 'boolean') tagger.setEnabled(enabled);
    if (backfill === 'accepted' || backfill === 'declined') tagger.setBackfill(backfill);
    return send(res, 200, { status: tagger.status() });
  }

  return { handleList, handleEdit, handleRetag, handleRename, handleDelete, handleSettings };
}
