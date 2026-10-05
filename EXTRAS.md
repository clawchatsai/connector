# ClawChats-only data (ExtrasStore)

The OCPlatform gateway is the source of truth for chats: sessions, groups (projects), titles,
pins, unread, transcripts, search. The connector stores **only** what the gateway has no place
for, in the global DB (`global.db`) via `server/store/extras-store.js`.

Add a row here whenever a ClawChats feature needs storage the gateway lacks.

| Feature | Table | Key | Notes |
|---|---|---|---|
| Project color / icon / new-chat preset | `project_styles` | group name | Gateway groups are only `{name, position}`. `preset` (JSON) holds what a new chat in the project starts with: `agentId`, `cwd` or `projectId` (+ `projectLabel`), `permissionMode`, `model`, `thinkingLevel`, `fastMode`; sanitized by `cleanPreset`. Renames/deletes issued by ClawChats (`sessions.groups.rename/delete`) move/drop the style (SessionLens). A rename done elsewhere leaves the style on the old name. |
| Per-thread extras | `thread_extras` | session key + kind | e.g. Intelligence panel versions. Dropped when the gateway reports the session deleted. |
| Legacy creation times | `legacy_created` | session key | Filled by the one-off `ocplatform clawchats import-dates` (insert-or-ignore, safe to re-run) from the pre-gateway `<project>.db` files (`threads.created_at`), `server/store/legacy-threads.js`. The gateway has no `createdAt` for those sessions and `sessions.patch` can't set it. SessionLens fills `createdAt` on listed rows that lack it. The command can be removed once all installs have run it; the table stays. |
| Bookmarks | `bookmarks` | id (unique per session key + message id) | Messages bookmarked from the thread. Stores the label (first sentence, renamable), a text snippet and the chat title at bookmark time, so the list reads without loading the chat. `message_id` is the transcript entry id the frontend renders (`history-projection` turn id). Dropped with the session's other extras when the gateway reports it deleted. |
| Prompt library | `prompts` | id | Unchanged. |
| Custom emojis | `custom_emojis` | name + pack | Unchanged. |
| Settings | `data/settings.json` | — | Unchanged. |

HTTP (P2P `rpc`):
- `GET /api/extras/project-styles` → `{ styles: { [groupName]: { color, icon } } }`
- `PUT /api/extras/project-styles/:name` `{ color?, icon? }` (absent = keep, null = clear)
- `DELETE /api/extras/project-styles/:name`

- `GET /api/extras/bookmarks` → `{ bookmarks: [{ id, sessionKey, messageId, role, label, snippet, chatTitle, createdAt, updatedAt }] }` (newest first)
- `POST /api/extras/bookmarks` `{ sessionKey, messageId, role, label, snippet, chatTitle }` → `{ bookmark }` (an existing bookmark on that message is returned unchanged)
- `PATCH /api/extras/bookmarks/:id` `{ label }` → `{ bookmark }`
- `DELETE /api/extras/bookmarks/:id`

Changes broadcast `{ type: 'clawchats', event: 'project-styles-changed' }` / `'bookmarks-changed'`.
