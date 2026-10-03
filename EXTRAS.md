# ClawChats-only data (ExtrasStore)

The OCPlatform gateway is the source of truth for chats: sessions, groups (projects), titles,
pins, unread, transcripts, search. The connector stores **only** what the gateway has no place
for, in the global DB (`global.db`) via `server/store/extras-store.js`.

Add a row here whenever a ClawChats feature needs storage the gateway lacks.

| Feature | Table | Key | Notes |
|---|---|---|---|
| Project color / icon | `project_styles` | group name | Gateway groups are only `{name, position}`. Renames/deletes issued by ClawChats (`sessions.groups.rename/delete`) move/drop the style (SessionLens). A rename done elsewhere leaves the style on the old name. |
| Per-thread extras | `thread_extras` | session key + kind | e.g. Intelligence panel versions. Dropped when the gateway reports the session deleted. |
| Legacy creation times | `legacy_created` | session key | Filled by the one-off `ocplatform clawchats import-dates` (insert-or-ignore, safe to re-run) from the pre-gateway `<project>.db` files (`threads.created_at`), `server/store/legacy-threads.js`. The gateway has no `createdAt` for those sessions and `sessions.patch` can't set it. SessionLens fills `createdAt` on listed rows that lack it. The command can be removed once all installs have run it; the table stays. |
| Prompt library | `prompts` | id | Unchanged. |
| Custom emojis | `custom_emojis` | name + pack | Unchanged. |
| Settings | `data/settings.json` | — | Unchanged. |

HTTP (P2P `rpc`):
- `GET /api/extras/project-styles` → `{ styles: { [groupName]: { color, icon } } }`
- `PUT /api/extras/project-styles/:name` `{ color?, icon? }` (absent = keep, null = clear)
- `DELETE /api/extras/project-styles/:name`

Changes broadcast `{ type: 'clawchats', event: 'project-styles-changed' }`.
