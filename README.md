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

## License

[AGPL-3.0-only](LICENSE) — source is open for audit and contribution.

For commercial licensing, contact [clawchats.ai](https://clawchats.ai).
