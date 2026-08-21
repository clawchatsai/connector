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

```bash
openclaw plugins install @clawchatsai/connector
openclaw gateway restart
```

Then open [app.clawchats.ai](https://app.clawchats.ai) and follow the setup flow.

## Companion workflow: TweetClaw for X/Twitter

ClawChats gives you a private browser UI for a local OpenClaw gateway. If the
same gateway also needs public X/Twitter automation, install
[TweetClaw](https://github.com/Xquik-dev/tweetclaw) alongside this connector:

```bash
openclaw plugins install clawhub:@xquik/tweetclaw
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

Use `openclaw plugins install npm:@xquik/tweetclaw` only when the npm fallback
is required.

Use ClawChats for the browser conversation, local files, memory, and P2P
transport. Use TweetClaw for scrape tweets, search tweets, search tweet replies,
follower export, user lookup, media upload, media download, direct messages,
monitor tweets, webhooks, giveaway draws, and approval-gated post tweets or post
tweet replies.

Keep the Xquik API key in OpenClaw config or environment variables, not in chat
messages or repository files. Review every visible X/Twitter action before
approval.

Xquik is an independent third-party service. Not affiliated with X Corp. "Twitter" and "X" are trademarks of X Corp.

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
  controllers/            # HTTP route handlers (threads, messages, workspaces, files, memory)
  providers/              # Memory backends (Qdrant, Postgres)
  util/                   # HTTP helpers, multipart parser, context builder, misc
src/                      # OpenClaw plugin wrapper (TypeScript)
  index.ts                # Plugin entry point — registers with OpenClaw, manages lifecycle
  signaling-client.ts     # Connects to ClawChats signaling server for P2P handshake
  webrtc-peer.ts          # WebRTC DataChannel peer — direct browser ↔ gateway connection
  auth-handler.ts         # TOTP + Google session auth for DataChannel connections
```

## Security & permissions

**Filesystem access:** The plugin reads/writes under `~/.openclaw/` (gateway data) and the user's home directory for workspace file browsing. File serving is restricted to an explicit allowlist (`HOME`, `/tmp`). Write access is limited to within `HOME`.

**Session cleanup:** When a thread or workspace is deleted, the plugin removes the associated OpenClaw session files (`.jsonl`) to prevent stale context. These are files created by the gateway itself during that session.

**Auth:** The DataChannel connection is authenticated with TOTP + Google session token before any data is processed. The HTTP API uses a local bearer token (set via `CLAWCHATS_AUTH_TOKEN` or `config.js`). No credentials are sent to external servers.

**No shell execution:** The plugin contains no `exec`, `spawn`, or shell calls. SQLite is handled by Node's built-in `node:sqlite` module — no native binary compilation required.

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

### Review and merge

`main` requires a pull request. See [docs/review-and-merge.md](docs/review-and-merge.md) for the branch protection rules and where review is recorded.

## License

[AGPL-3.0-only](LICENSE) — source is open for audit and contribution.

For commercial licensing, contact [clawchats.ai](https://clawchats.ai).
