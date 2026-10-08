#!/bin/bash
# Reload the installed connector only when the gateway is idle: no chat run in flight (a queued reload
# holds new runs behind a long one) and no approval or question waiting (a reload strands them).
# Run it detached from a chat turn:  systemd-run --user --collect <repo>/scripts/reload-when-idle.sh
OC="$(command -v openclaw || echo "$HOME/.npm-global/bin/openclaw")"

# Prints "<active runs> <pending approvals> <pending questions>"; 99 when the gateway can't be asked.
busy() {
  local runs ex pl qs
  runs=$("$OC" gateway call sessions.list --params '{"limit":200}' --json 2>/dev/null | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0));console.log((j.sessions||[]).filter(s=>s.hasActiveRun).length)}catch{console.log(99)}')
  ex=$("$OC" gateway call exec.approval.list --params '{}' --json 2>/dev/null | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0));console.log((Array.isArray(j)?j:j.approvals||[]).length)}catch{console.log(99)}')
  pl=$("$OC" gateway call plugin.approval.list --params '{}' --json 2>/dev/null | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0));console.log((Array.isArray(j)?j:j.approvals||[]).length)}catch{console.log(99)}')
  qs=$("$OC" gateway call question.list --params '{}' --json 2>/dev/null | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0));console.log((j.questions||[]).length)}catch{console.log(99)}')
  echo "$runs $((ex + pl)) $qs"
}

if [ "$1" = "--status" ]; then busy; exit 0; fi

for i in $(seq 1 180); do   # up to ~30 min
  read -r runs approvals questions <<< "$(busy)"
  if [ "$runs" = 0 ] && [ "$approvals" = 0 ] && [ "$questions" = 0 ]; then
    echo "idle at $(date +%T): reloading"
    exec "$OC" plugins reload connector --wait
  fi
  sleep 10
done
echo "gave up at $(date +%T): runs=$runs approvals=$approvals questions=$questions; not reloading"
exit 1
