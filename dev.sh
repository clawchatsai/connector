#!/bin/bash
# dev.sh — Build connector + start OpenClaw dev gateway
#
# Run this first, then start the ClawChats frontend in ~/clawchats:
#   Terminal 1:  cd ~/connector && ./dev.sh
#   Terminal 2:  cd ~/clawchats && ./dev.sh
#
# Usage:
#   ./dev.sh              Build + start gateway (foreground)
#   ./dev.sh --skip-build Skip build, just start gateway
#   ./dev.sh --watch      Watch-mode tsc (auto-recompile; restart gateway manually after each rebuild)
#   ./dev.sh --build-only Build only, don't start gateway
#
set -e

REPO="$(cd "$(dirname "$0")" && pwd)"
DEV_DIR="$HOME/.openclaw-dev"
GW_PORT=19001

SKIP_BUILD=false
WATCH=false
BUILD_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --watch)      WATCH=true; SKIP_BUILD=true ;;
    --build-only) BUILD_ONLY=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

cleanup() {
  echo ""
  echo "Stopping dev gateway..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null
  echo "Stopped."
}
PIDS=()
trap cleanup EXIT INT TERM

echo "🔌 Connector Dev"
echo "─────────────────────────────"

# 1. Install deps if needed
if [ ! -d "$REPO/node_modules" ]; then
  echo "  📦 Installing dependencies..."
  npm install 2>&1 | tail -1
fi

# 2. Build
if [ "$WATCH" = true ]; then
  echo "  👀 Starting watch-mode tsc..."
  echo "  ⚠️  Run 'openclaw --dev gateway restart' after each rebuild to reload"
  npm run dev &
  PIDS+=($!)
elif [ "$SKIP_BUILD" = false ]; then
  echo "  🔨 Building connector..."
  npm run build 2>&1 | tail -3
  echo "  ✓ Build complete"
fi

[ "$BUILD_ONLY" = true ] && echo "  Done (--build-only)." && exit 0

# 3. Ensure dev gateway config
mkdir -p "$DEV_DIR"
if [ ! -f "$DEV_DIR/openclaw.json" ]; then
  echo "  ⚙️  Creating dev gateway config..."
  cat > "$DEV_DIR/openclaw.json" << EOF
{
  "gateway": {
    "port": $GW_PORT,
    "bind": "loopback",
    "mode": "local"
  },
  "plugins": {
    "allow": ["connector"],
    "load": {
      "paths": ["$REPO"]
    },
    "entries": {
      "connector": {
        "enabled": true
      }
    }
  }
}
EOF
else
  # Ensure allow + load.paths are present (idempotent patch)
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$DEV_DIR/openclaw.json', 'utf8'));
    cfg.plugins = cfg.plugins || {};
    cfg.plugins.allow = ['connector'];
    cfg.plugins.load = { paths: ['$REPO'] };
    fs.writeFileSync('$DEV_DIR/openclaw.json', JSON.stringify(cfg, null, 2));
  "
fi
echo "  ⚙️  Dev gateway config: $DEV_DIR/openclaw.json"

# 4. Start dev gateway
echo "  ⚡ Starting dev gateway (port $GW_PORT)..."
CLAWCHATS_DEV=true \
  GATEWAY_WS_URL=ws://localhost:$GW_PORT \
  openclaw --dev gateway run --port $GW_PORT --force 2>&1 | sed 's/^/  [gateway] /' &
PIDS+=($!)

echo ""
echo "─────────────────────────────"
echo "✅ Connector dev running:"
echo "   Gateway:    ws://localhost:$GW_PORT (dev profile)"
echo "   Plugin:     $REPO/dist/index.js"
echo "   State:      $DEV_DIR"
echo ""
echo "Now start the frontend:"
echo "   cd ~/clawchats && ./dev.sh"
echo ""
echo "Press Ctrl+C to stop"
echo ""

wait
