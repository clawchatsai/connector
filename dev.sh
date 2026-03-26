#!/bin/bash
# dev.sh — Watch-mode TypeScript build for connector development
#
# Run this in a terminal while editing server/ or src/ files.
# TypeScript compiles automatically on save. Pair with clawchats/dev.sh
# for a full dev loop:
#
#   Terminal 1 (connector):   cd ~/connector && ./dev.sh
#   Terminal 2 (full stack):  cd ~/clawchats && ./dev.sh --skip-build
#
# After tsc rebuilds dist/, restart the dev gateway to pick up changes:
#   openclaw --dev gateway restart
#
# Usage:
#   ./dev.sh          Watch-mode (recompiles on changes)
#   ./dev.sh --once   Single build only (same as: npm run build)
#   ./dev.sh --server Build server.js bundle via esbuild (for production deploy)
#
set -e

cd "$(dirname "$0")"

case "${1:-}" in
  --once)
    echo "🔨 Building connector (single pass)..."
    npm run build
    echo "✓ Build complete. dist/ is ready."
    ;;
  --server)
    echo "🔨 Building server.js bundle (esbuild)..."
    node esbuild.config.mjs
    echo "✓ server.js built."
    ;;
  *)
    echo "👀 connector — watching for TypeScript changes (Ctrl+C to stop)"
    echo "   Tip: run 'openclaw --dev gateway restart' after each rebuild to reload"
    echo ""
    npm run dev
    ;;
esac
