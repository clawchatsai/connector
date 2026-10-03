#!/bin/bash
# Deploy this working tree into the connector installed on this machine's OpenClaw gateway,
# for testing before an npm release. Does NOT reload the plugin (see the end of this script).
#
#   scripts/deploy-local.sh           build + deploy, refusing to overwrite another chat's branch
#   scripts/deploy-local.sh --force   overwrite anyway (that other work is finished or abandoned)
#
# There is one installed connector shared by every chat, so a marker file in it records which
# branch was deployed. Deploying over a different branch that isn't merged into origin/main is
# refused: that chat is probably still testing it. A fresh npm install has no marker (= release).
set -e
cd "$(dirname "$0")/.."

FORCE=0
[ "$1" = "--force" ] && FORCE=1

# CONNECTOR_DIR overrides the target (used to test this script against a copy).
D="${CONNECTOR_DIR:-$(ls -d ~/.openclaw/npm/projects/clawchatsai-connector-*/node_modules/@clawchatsai/connector 2>/dev/null | head -1)}"
[ -n "$D" ] || { echo "installed connector not found under ~/.openclaw/npm/projects" >&2; exit 1; }
MARKER="$D/.deployed-from"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse HEAD)"

if [ -f "$MARKER" ] && [ "$FORCE" != 1 ]; then
  PREV_BRANCH="$(sed -n 1p "$MARKER")"
  PREV_SHA="$(sed -n 2p "$MARKER")"
  PREV_DIRTY="$(sed -n 4p "$MARKER")"
  git fetch -q origin main || true
  # Uncommitted edits were deployed, or the commit isn't on main yet: that work is unmerged.
  if [ "$PREV_BRANCH" != "$BRANCH" ] && { [ "$PREV_DIRTY" = dirty ] || ! git merge-base --is-ancestor "$PREV_SHA" origin/main 2>/dev/null; }; then
    echo "The installed connector is branch '$PREV_BRANCH' (unmerged), deployed $(sed -n 3p "$MARKER")." >&2
    echo "Another chat is probably testing it. Ask Houman, or pass --force if that work is done." >&2
    exit 1
  fi
fi

# A fresh worktree has no node_modules.
[ -d node_modules ] || npm ci --silent

npm run build
# The plugin imports ../server/index.js (source dir), not a bundle.
rsync -a --delete --exclude='*.test.js' server/ "$D/server/"
cp dist/*.js "$D/dist/"
DIRTY=clean
[ -z "$(git status --porcelain -- server src)" ] || DIRTY=dirty
printf '%s\n%s\n%s\n%s\n' "$BRANCH" "$SHA" "$(date -Is) from $(pwd)" "$DIRTY" > "$MARKER"

echo "✅ Deployed branch $BRANCH ($(git rev-parse --short HEAD)) to $D"
echo "Next: reload the plugin while no ClawChats turn is in flight. From inside a chat turn:"
echo "  systemd-run --user --collect $(command -v openclaw || echo openclaw) plugins reload connector --wait"
