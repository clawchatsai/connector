#!/usr/bin/env bash
# Usage inside the container: run-test.sh <install-spec>
# <install-spec> is an npm spec (@clawchatsai/connector@0.1.44) or a tarball path.
set -u
SPEC="${1:-@clawchatsai/connector}"
export PATH=/home/tester/.openclaw/bin:$PATH
echo "== platform: $(uname -m) openclaw $(openclaw --version)"
openclaw gateway run --port 18789 >/tmp/gateway.log 2>&1 &
for i in $(seq 1 60); do curl -fs http://127.0.0.1:18789/ >/dev/null 2>&1 && break; sleep 1; done
echo "== gateway http up after ${i}s"
# HTTP answering is not the same as ready for plugin RPCs (slow on emulated arm64): wait for health.
for j in $(seq 1 120); do openclaw health >/dev/null 2>&1 && break; sleep 3; done
echo "== gateway healthy after $((j*3))s more"
echo "== install $SPEC"
INSTALL_OUT=$(openclaw plugins install "$SPEC" --force --accept-capabilities 2>&1 | tail -15)
echo "$INSTALL_OUT"
# When the CLI could not reach the live gateway (slow emulated hosts) the plugin is only saved:
# restart the gateway so the plugin loads, as a user would.
if echo "$INSTALL_OUT" | grep -q "Saved for the next Gateway start"; then
  echo "== restarting gateway to load the saved plugin"
  kill %1 2>/dev/null; sleep 3
  openclaw gateway run --port 18789 >/tmp/gateway.log 2>&1 &
  for i in $(seq 1 240); do curl -fs http://127.0.0.1:18789/ >/dev/null 2>&1 && break; sleep 1; done
  for j in $(seq 1 120); do openclaw health >/dev/null 2>&1 && break; sleep 3; done
  sleep 5
fi
echo "== plugins inspect"
openclaw plugins inspect connector 2>&1 | head -20
echo "== status before setup"
openclaw clawchats status 2>&1 | head -8

# Simulated setup: a fake config pointing at a closed port. Exercises the post-setup start path
# (native WebRTC module, server load, signaling attempt) without needing a real account.
mkdir -p ~/.openclaw/clawchats
cat > ~/.openclaw/clawchats/config.json <<JSON
{"userId":"u-test","apiKey":"k-test","serverUrl":"wss://127.0.0.1:9"}
JSON
sleep 12
echo "== status after (simulated) setup"
openclaw clawchats status 2>&1 | head -8
echo "== gateway log (clawchats)"
grep -i -E "clawchats|connector|signaling|node-datachannel|WebRTC" /tmp/gateway.log | cut -c1-260 | tail -14
echo "== gateway connection diagnostics"
grep -i -E "\[ws\]|pair|handshake|unauthorized|scope|device|connect.*gateway|gateway.*connect" /tmp/gateway.log | cut -c1-240 | tail -25
