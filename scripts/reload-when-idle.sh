#!/bin/bash
# Reload the installed connector once that is safe. Run it detached from a chat turn:
#   systemd-run --user --collect <repo>/scripts/reload-when-idle.sh
#
# A reload waits for whatever holds the connector, and while it waits new runs gateway-wide wait behind it.
# - Hosts where the connector hands running turns over (OpenClaw 2026.11.5+, manifest reload.turnHandover): running
#   turns move to the new connector at their next model step, so the reload doesn't wait for them. It still waits for
#   approvals and questions: their turn sits inside a tool call until they're answered, with every new run queued
#   behind it. If the reload fails anyway (a long tool call outlasted its 60 s drain, or the connector the gateway
#   loaded predates reload.turnHandover), it falls back to waiting for idle.
# - Otherwise (2026.9.7): wait until no chat run is in flight and nothing waits for approval or an answer.
OC="$(command -v openclaw || echo "$HOME/.npm-global/bin/openclaw")"

# Prints "<active runs> <pending approvals> <pending questions>"; 99 when the gateway can't be asked.
busy() {
  local runs ap qs
  runs=$("$OC" gateway call sessions.list --params '{"limit":200}' --json 2>/dev/null | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0));console.log((j.sessions||[]).filter(s=>s.hasActiveRun).length)}catch{console.log(99)}')
  # `approvals pending` lists every pending exec/plugin/system-agent approval; `gateway call exec.approval.list`
  # only shows the ones this CLI device may review (often none).
  ap=$("$OC" approvals pending --json 2>/dev/null | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0));console.log((j.approvals||[]).length)}catch{console.log(99)}')
  qs=$("$OC" gateway call question.list --params '{}' --json 2>/dev/null | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0));console.log((j.questions||[]).length)}catch{console.log(99)}')
  echo "${runs:-99} ${ap:-99} ${qs:-99}"   # empty = couldn't ask = not idle
}

# "yes" when the gateway hands this connector's running turns over on reload.
handover() {
  "$OC" plugins inspect connector --json 2>/dev/null | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0));console.log(j.plugin?.turnHandover===true?"yes":"no")}catch{console.log("no")}'
}

if [ "$1" = "--status" ]; then busy; exit 0; fi
if [ "$1" = "--handover" ]; then handover; exit 0; fi

HANDOVER=$(handover)
for i in $(seq 1 180); do   # up to ~30 min
  read -r runs approvals questions <<< "$(busy)"
  if [ "$HANDOVER" = yes ] && [ "$approvals" = 0 ] && [ "$questions" = 0 ]; then
    echo "$(date +%T): $runs run(s) in flight, nothing waiting for an answer: reloading (running turns hand over)"
    "$OC" plugins reload connector && exit 0
    echo "$(date +%T): reload didn't apply; waiting for idle instead"
    HANDOVER=no
  elif [ "$runs" = 0 ] && [ "$approvals" = 0 ] && [ "$questions" = 0 ]; then
    echo "idle at $(date +%T): reloading"
    exec "$OC" plugins reload connector --wait
  fi
  sleep 10
done
echo "gave up at $(date +%T): runs=$runs approvals=$approvals questions=$questions; not reloading"
exit 1
