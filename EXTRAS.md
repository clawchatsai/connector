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
| Team chats | `team_rooms`, `team_members`, `team_entries` | room session key | Several agents in one thread (`server/team.js`, `server/store/team-store.js`). The gateway has no multi-agent session: a room is a session that never runs (entries written with `chat.inject`, "[Label]" prefix), each agent runs in its own working session (`team_members.work_key`, hidden by SessionLens, run events still forwarded), `seen_at` = newest room entry the agent was given, `team_entries` = author of each injected entry. Deleting the room deletes its working sessions. |
| Prompt library | `prompts` | id | Unchanged. |
| Custom emojis | `custom_emojis` | name + pack | Unchanged. |
| Settings | `data/settings.json` | — | Unchanged. |
| Share links | `data/shares.json` (+ `data/share-storage.json`) | share id | Bring-your-own storage (`controllers/shares.js`, `share/`). The browser encrypts; the connector wraps the ciphertext in a self-contained viewer page (`share/viewer.html` + `viewer-decrypt.js`) and uploads it with S3 SigV4 (`share/s3.js`) to the user's own R2 bucket, set up from one R2 API token (`share/r2-setup.js`: creates `clawchats-shares`, turns on its r2.dev URL, derives S3 keys; the raw token isn't kept). `share-storage.json` (0600) holds the derived keys and is never sent to the browser. The index keeps id, url, title, type, mode and expiry, never the decryption key. Expired shares are deleted hourly and on list/create. |

HTTP (P2P `rpc`):
- `GET /api/extras/project-styles` → `{ styles: { [groupName]: { color, icon } } }`
- `PUT /api/extras/project-styles/:name` `{ color?, icon? }` (absent = keep, null = clear)
- `DELETE /api/extras/project-styles/:name`

- `GET /api/extras/bookmarks` → `{ bookmarks: [{ id, sessionKey, messageId, role, label, snippet, chatTitle, createdAt, updatedAt }] }` (newest first)
- `POST /api/extras/bookmarks` `{ sessionKey, messageId, role, label, snippet, chatTitle }` → `{ bookmark }` (an existing bookmark on that message is returned unchanged)
- `PATCH /api/extras/bookmarks/:id` `{ label }` → `{ bookmark }`
- `DELETE /api/extras/bookmarks/:id`

Share links:
- `GET /api/extras/shares` → `{ configured, storage: { provider, bucket, publicBaseUrl } | null, shares: [...] }`
- `POST /api/extras/shares/storage` `{ token }` (R2 API token, Admin Read & Write) → `{ storage }` after a test upload · `DELETE /api/extras/shares/storage` forgets it
- `POST /api/extras/shares` `{ envelope, expiresAt?, title, type }` → `{ share }` · `DELETE /api/extras/shares/:id`

Changes broadcast `{ type: 'clawchats', event: 'project-styles-changed' }` / `'bookmarks-changed'`.

Team chats (`:room` = URL-encoded room session key):
- `GET /api/team` → `{ rooms: [{ roomKey, discuss, agents: [{ agentId, workKey }], running: [agentId], queued }] }`
- `POST /api/team` `{ agentIds, sourceKey?, category?, label? }` → `{ room }` (`sourceKey`: convert an existing chat; it becomes its agent's working session)
- `GET /api/team/:room` → `{ room }` with `authors: { [messageId]: { type: 'user'|'agent', agentId } }`
- `PATCH /api/team/:room` `{ discuss }` · `POST /api/team/:room/agents` `{ agentId }` · `DELETE /api/team/:room/agents/:agentId`
- `POST /api/team/:room/send` `{ text, userLabel }` → `{ messageId }` (agents run in the background)
- `POST /api/team/:room/stop`

Events: `{ type: 'clawchats', event: 'team-changed' }` (rooms or members changed) and
`{ type: 'clawchats', event: 'team-status', roomKey, running, queued, error? }`.
