// Gateway session cleanup for deleted threads/workspaces.
// 2026.9+ gateways keep sessions in SQLite and own their lifecycle, so cleanup goes
// through the `sessions.delete` RPC (same as the Control UI) instead of touching files.

let _gatewayClient = null;

export function setGatewayClient(client) {
  _gatewayClient = client;
}

/** Delete one gateway session (row + transcript). Best effort; never throws. */
export async function cleanGatewaySession(sessionKey) {
  if (!sessionKey || !_gatewayClient) return false;
  try {
    await _gatewayClient.request('sessions.delete', { key: sessionKey, deleteTranscript: true });
    return true;
  } catch (err) {
    // A thread that never sent a message has no gateway session; that's fine.
    if (!/not found|no session|unknown session/i.test(err.message)) {
      console.warn(`cleanGatewaySession(${sessionKey}): ${err.message}`);
    }
    return false;
  }
}

/** Delete several gateway sessions by exact key. Returns how many were deleted. */
export async function cleanGatewaySessions(sessionKeys) {
  let cleaned = 0;
  for (const key of sessionKeys) if (await cleanGatewaySession(key)) cleaned++;
  return cleaned;
}
