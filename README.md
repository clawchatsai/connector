# @clawchatsai/connector

OpenClaw plugin for [ClawChats](https://clawchats.ai) — a self-hosted chat interface for your AI agents.

## What it does

This plugin runs a local HTTP + WebSocket server alongside the OpenClaw gateway. It:

- Stores your conversation history in a local SQLite database (one per workspace)
- Serves the ClawChats web UI from your machine
- Relays messages between your browser and the OpenClaw gateway
- Optionally connects to the ClawChats signaling server (`wss://login.clawchats.ai`) to coordinate a P2P WebRTC connection between your browser and gateway — for device pairing and cross-device access

The plugin runs entirely on your machine. Conversation data never leaves your device — P2P means your browser connects directly to your gateway over encrypted WebRTC (DTLS). The signaling server at `wss://login.clawchats.ai` is used only to coordinate the initial connection handshake. After that, it's out of the picture.

## Installation

```bash
openclaw plugins install @clawchatsai/connector
```

Then restart the gateway:

```bash
openclaw gateway restart
```

Open your browser at the URL shown in the OpenClaw dashboard.

## Architecture

```
Browser  ←──WebSocket──→  connector (this plugin)  ←──WebSocket──→  OpenClaw Gateway
                                    │
                                    └──── SQLite (local, per workspace)
                                    └──── HTTP API (threads, messages, files, memory)
                                    └──── Static file server (ClawChats UI)
```

The plugin runs entirely on your machine. No conversation data leaves your device unless you explicitly enable P2P features.

## Source layout

```
server/                   # Backend server (Node.js, plain ESM)
  index.js                # createApp() factory + router + standalone entry
  gateway.js              # GatewayClient — WebSocket relay to OpenClaw
  config.js               # Config discovery (env vars, openclaw.json)
  debug.js                # Debug session logger
  gateway-cleanup.js      # Session cleanup helpers
  bootstrap/
    native.js             # better-sqlite3 ABI auto-rebuild
    identity.js           # ed25519 device signing (OpenClaw ≥2.15)
  controllers/            # Route handlers
  providers/              # Memory backends (Qdrant, Postgres)
  util/                   # HTTP helpers, multipart, context, misc
src/                      # OpenClaw plugin wrapper (TypeScript)
  index.ts                # Plugin entry point — registers with OpenClaw
  signaling-client.ts     # P2P signaling client
  webrtc-peer.ts          # WebRTC data channel peer
```

## Configuration

Auth token and gateway URL are read from:
1. Environment variables (`CLAWCHATS_AUTH_TOKEN`, `CLAWCHATS_GATEWAY_WS_URL`)
2. `~/.openclaw/openclaw.json`
3. `config.js` in the plugin directory (local override, gitignored)

## License

[AGPL-3.0-only](LICENSE) — see LICENSE for full terms.

For commercial licensing, contact [clawchats.ai](https://clawchats.ai).
