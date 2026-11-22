# @clawchatsai/connector

OpenClaw plugin that bridges the [ClawChats](https://clawchats.ai) web app to your local OpenClaw gateway.

## What it does

When installed, this plugin runs as a background service alongside your OpenClaw gateway. It:

- Connects to the OpenClaw gateway WebSocket and persists conversation history to a local SQLite database
- Connects to the ClawChats signaling server (`wss://login.clawchats.ai`) to establish a P2P WebRTC session with your browser
- Once the P2P connection is established, your browser communicates directly with this plugin — no data passes through any external server
- Exposes a local HTTP/WebSocket API for threads, messages, workspaces, file management, and memory

## How the connection works

```
app.clawchats.ai  ──── signaling server ────  connector plugin (your machine)
  (browser UI)        (handshake only)          (OpenClaw gateway)
        │                                               │
        └──────── WebRTC DataChannel (P2P) ────────────┘
                  encrypted, direct, no relay
```

1. You open [app.clawchats.ai](https://app.clawchats.ai) in your browser
2. The browser authenticates with `login.clawchats.ai` and gets a session token
3. The signaling server coordinates a WebRTC handshake between your browser and this plugin
4. Your browser connects directly to your gateway via an encrypted P2P DataChannel
5. All conversation data — messages, files, memory — travels over that direct connection

The signaling server only facilitates the handshake. After step 4, it is out of the picture.

## Installation

Requires OpenClaw 2026.9.7 or newer on the machine that runs your gateway.

```bash
openclaw gateway stop && openclaw plugins install npm:@clawchatsai/connector --force --accept-capabilities && openclaw gateway start
```

This stops the gateway for a moment, installs the plugin, and starts the gateway again with it loaded.
Stopping first avoids the install failing with a gateway ownership or lock error, which happens for
example when OpenClaw was updated but the running gateway is still the old version.

- `--force` confirms the npm source, which is outside ClawHub review.
- `--accept-capabilities` approves the capabilities the plugin declares (review them with
  `openclaw plugins inspect connector`).
- Keep the `npm:` prefix: since OpenClaw 2026.11, a package name without a prefix is looked up only
  on ClawHub, and the install fails with "Package not found on ClawHub".

If your gateway runs in a container where stopping it also stops the container, run the install
without the stop and start: `openclaw plugins install npm:@clawchatsai/connector --force`. A running
gateway loads the plugin right away.

Then connect it to your ClawChats account:

1. Open [app.clawchats.ai](https://app.clawchats.ai), sign in, and choose **Connect a gateway**.
2. Run the `openclaw clawchats setup <token>` command it shows, on the gateway machine.
3. Check the result: `openclaw clawchats status` — Gateway and Signaling should say `connected`.

Until step 2 is done the plugin idles and `openclaw clawchats status` says it is waiting for setup.

### Supported platforms

A WebRTC binary is bundled for Linux (x64, arm64, arm; glibc and musl), macOS (Intel and Apple
silicon) and Windows (x64, arm64). Nothing is compiled during install.

### Troubleshooting

| Symptom | What to do |
| --- | --- |
| `openclaw clawchats status` says *waiting for setup* | Finish step 2 above. |
| Status says *failed to start* | The message names the cause and the fix. After fixing, run `openclaw plugins reload connector`. |
| Signaling shows `disconnected` | The gateway machine cannot reach the ClawChats server (offline, proxy or firewall). It keeps retrying; see `journalctl --user -u openclaw-gateway -g clawchats`. |
| Gateway on a custom port, profile or state directory | Supported: the plugin follows the gateway's config, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`. |

## Architecture

```
server/                   # Local backend server (Node.js, plain ESM)
  index.js                # createApp() factory — HTTP API + WebSocket relay to OpenClaw
  gateway.js              # GatewayClient — maintains connection to local OpenClaw gateway
  config.js               # Config discovery (env vars → openclaw.json → defaults)
  debug.js                # Debug session logger
  gateway-cleanup.js      # Session cleanup on thread/workspace delete
  bootstrap/
    native.js             # node:sqlite initialisation (built into Node ≥22.5, no compilation)
    identity.js           # ed25519 device signing for OpenClaw ≥2.15
  controllers/            # HTTP route handlers (files, workspace, gateway media, transcribe, settings)
  util/                   # HTTP helpers, multipart parser, context builder, misc
  push/                   # Push notifications to the owner's devices: RFC 8291 encryption + VAPID (web-push.js),
                          # subscriptions (store.js), presence, VAPID tokens from the signal server (vapid.js), notifier.js
src/                      # OpenClaw plugin wrapper (TypeScript)
  index.ts                # Plugin entry point — registers with OpenClaw, manages lifecycle
  signaling-client.ts     # Connects to ClawChats signaling server for P2P handshake
  webrtc-peer.ts          # WebRTC DataChannel peer — direct browser ↔ gateway connection
  auth-handler.ts         # TOTP + Google session auth for DataChannel connections
```

## Security & permissions

**Filesystem access:** The plugin reads/writes under `~/.openclaw/` (gateway data) and the user's home directory for workspace file browsing. File serving is restricted to an explicit allowlist (`HOME`, `/tmp`). Write access is limited to within `HOME`.

**Session cleanup:** When a thread or workspace is deleted, the plugin removes the associated OpenClaw session files (`.jsonl`) to prevent stale context. These are files created by the gateway itself during that session.

**Auth:** Before any data is processed, the connector proves its identity to the browser (a signature over the WebRTC connection's DTLS fingerprints, made with the connector's own key), then the browser logs in by signing the same data with its device key. A new browser pairs once with a TOTP or backup code. There is no session token. Manage paired browsers with `openclaw clawchats devices` and `openclaw clawchats devices revoke <id|label>`; compare the connector key with `openclaw clawchats show-fingerprint`. The HTTP API uses a local bearer token (set via `CLAWCHATS_AUTH_TOKEN` or `config.js`). No credentials are sent to external servers.

**Push notifications:** only once you turn them on for a device (ClawChats Settings → Phone & background notifications), the connector sends that device's notifications itself: each message is encrypted to the device (RFC 8291) and POSTed to the browser's push service (Google FCM, Apple, Mozilla or Windows), which sees only ciphertext. The ClawChats server signs a short-lived VAPID token for each push service about twice a day and never sees the messages, the device addresses or when they are sent. Device subscriptions are kept in `push-subscriptions.json` in the connector's data dir (0600); approvals and questions waiting for an answer, and which devices were told, in `push-pending.json` (0600), so a reload doesn't push them again.

**No shell execution:** The plugin contains no `exec`, `spawn`, or shell calls. SQLite is handled by Node's built-in `node:sqlite` module — no native binary compilation required.

## Progress cards in claude-cli chats

OpenClaw tells the agent about its task progress card only when the chat runs on its built-in runtime. Chats on `claude-cli` (or another `*-cli` runtime) never get that instruction, so their agent almost never shows a progress card. The connector can add the missing line itself, but the gateway only lets a third-party plugin add to the agent's instructions once you allow it:

```bash
openclaw config set plugins.entries.connector.hooks.allowConversationAccess true
```

This needs OpenClaw 2026.11.6 or later: on older gateways a claude-cli agent's `progress_card` calls fail in the gateway, so the connector doesn't add the reminder there. The change applies without a gateway restart. Until it's set, the gateway log says once per start that the reminder is blocked, and ClawChats shows a one-time tip in claude-cli chats.

**What the setting grants:** read access to conversation content in the connector's prompt hooks. The gateway has one switch for every hook that can see a chat's messages, so turning it on would let any such hook of the connector read them. The connector registers two `before_prompt_build` hooks, and neither reads the conversation. This one looks only at the chat's model provider and session key, and on claude-cli chats (not the agent's main session, not subagents) it appends one fixed line about `progress_card` to the system prompt. The other adds [project instructions](#project-instructions). Neither stores nor sends anything anywhere.

**Why it asks:** this is a workaround for a gap in OpenClaw, and it goes away once OpenClaw reminds CLI runtimes itself. It does nothing when progress cards are off (`tools.updatePlan: false`) or prompt hooks are off for the connector (`plugins.entries.connector.hooks.allowPromptInjection: false`). To undo it, set the value back to `false`.

## Project instructions

In ClawChats, **Project settings → Instructions** holds text that every chat in the project follows, like Claude.ai or ChatGPT Projects: the files to read first, the rules to keep. The connector stores it on this machine (`global.db`, table `project_styles`, see `EXTRAS.md`) and adds it to the system prompt of each turn through a `before_prompt_build` hook. It uses the same setting as the progress-card reminder above:

```bash
openclaw config set plugins.entries.connector.hooks.allowConversationAccess true
```

Until it's set, the instructions are saved but not used, and the Project settings sheet says so.

**Which chats get them:**
- Your own chats in the project, and every chat they start (sub-chats and subagents, at any depth), on any model.
- Team chats in the project only when **Also in team chats** is on: other people read and write there and can see what the agent does with them.
- Nothing else: chats where your agent answers in someone else's team chat, channel chats (Discord, WhatsApp, …), the agent's main session, automations that don't run in a project chat, and any session the connector can't place.

The decision is per chat, made by the connector, because the gateway has no owner signal for every runtime and turns from people you share with reach it through the connector. If anything fails, the turn runs without the instructions. An edit applies from each chat's next turn, which costs one prompt-cache rewrite per open chat; unchanged turns are cached as before. Instructions are capped at 8,000 characters. When you save, any file path in them that doesn't exist on this machine is flagged under the box (relative paths are read from the agent workspace).

## Configuration

Config is read in priority order:
1. Environment variables (`CLAWCHATS_AUTH_TOKEN`, `GATEWAY_WS_URL`, `OPENCLAW_SESSIONS_DIR`)
2. `~/.openclaw/openclaw.json` (OpenClaw gateway config)
3. `config.js` in the plugin directory (local override, gitignored)

## Development

To work on the connector locally alongside the ClawChats frontend:

### Prerequisites

- Node.js 22+
- OpenClaw installed and on your `PATH`
- The `clawchats` repo cloned at `~/clawchats` (or set `CONNECTOR_DIR` when calling its `dev.sh`)

### Build

```bash
npm install
npm run build        # tsc — compiles src/ → dist/
node esbuild.config.mjs   # bundles server/ → server.js (production deploy only)
```

Or use the dev script:

```bash
./dev.sh             # watch-mode tsc (recompiles on save)
./dev.sh --once      # single build
./dev.sh --server    # esbuild bundle (for deploy)
```

### Running the full stack

The connector runs as an OpenClaw plugin — it can't run standalone. Use the ClawChats dev stack to run everything together:

```bash
# From the clawchats repo:
cd ~/clawchats && ./dev.sh --skip-build
```

See the ClawChats frontend repo for the full dev stack setup flow.

### Hot-reload loop

```bash
# Terminal 1 — watch-mode compiler
cd ~/connector && ./dev.sh

# Terminal 2 — full stack (no rebuild)
cd ~/clawchats && ./dev.sh --skip-build
```

After each tsc rebuild, reload the plugin:
```bash
openclaw --dev gateway restart
```

### Publishing

Releases are automated via GitHub Actions. Push a tag to trigger:

```bash
git tag v0.1.3
git push origin main --tags
```

The workflow runs `npm publish` to `@clawchatsai/connector` automatically. Do not run `npm publish` manually.

## License

[AGPL-3.0-only](LICENSE) — source is open for audit and contribution.

For commercial licensing, contact [clawchats.ai](https://clawchats.ai).
