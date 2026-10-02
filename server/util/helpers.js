// Legacy ClawChats session keys: agent:<agent>:<workspace>:chat:<threadId>.
// Used by the history exporter.
export function parseSessionKey(sessionKey) {
  if (!sessionKey) return null;
  const match = sessionKey.match(/^agent:([^:]+):([^:]+):chat:([^:]+)$/);
  if (!match) return null;
  return { agent: match[1], workspace: match[2], threadId: match[3] };
}
