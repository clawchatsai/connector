# connector — OpenClaw plugin

`@clawchatsai/connector`. Runs on the user's machine alongside the OpenClaw gateway. Bridges the ClawChats browser UI to the local gateway via a WebRTC P2P DataChannel after a handshake through `login.clawchats.ai`. See `README.md` for the full architecture diagram and install flow.

## Stack
- Node.js ≥22.5 (uses built-in `node:sqlite` — no native compile)
- TypeScript for the plugin wrapper (`src/`), plain ESM JS for the local server (`server/`)
- `node-datachannel` for WebRTC, `jose` for JWTs, `ws` for WebSockets

## Layout
- `src/` — TypeScript plugin wrapper (OpenClaw entry point, signaling client, WebRTC peer, auth)
- `server/` — plain ESM Node.js backend (HTTP API + WS relay to OpenClaw gateway)
- `dist/` — build output (committed-ish via npm publish, do not hand-edit)
- `prebuilds/` — prebuilt native binaries for `node-datachannel`

## Dev
```bash
npm run build      # tsc
npm run dev        # tsc --watch
```

## Cross-repo context

This repo has a sibling at `../clawchats/` which is the frontend + signaling server side of the same product. When changing wire-level contracts (signaling messages, RPC shapes, API versions), check `clawchats/shared/` for the matching types and update both sides. See `/home/houman/repos/CLAUDE.md` for the full workspace picture.
