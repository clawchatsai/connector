// The reply to one turn, read from its session's transcript: for runs the connector couldn't follow live (it or the
// gateway restarted mid-turn). peer/sharing.js (_replyTo) and team.js (recover) share it.
//
// The gateway can add a "continue" turn of its own (a user message with provenance internal_system): after it
// restarted mid-run, and on 2026.11.6 after a plugin reload hands a turn over (reload.turnHandover). A reload asked for
// during the turn's final step still gets that extra step, and the agent tends to restate its answer there ("The
// plugin reload is noted. I've completed..."; known-gaps/turn-handover-extra-step.md in the clawchats repo). So the
// reply is the first assistant message that ended the turn (stopReason "stop"); a run a restart cut off has none
// before the continue, and then its last text counts, as before.

const textOf = m => {
  const c = m?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n') : '';
};

/** Index of the prompt sent with idempotency key `runId` (the gateway records it as `${runId}:user`), or -1. */
export function promptIndex(messages, runId) {
  return messages.findIndex(m => m?.role === 'user' && m.__openclaw?.idempotencyKey === `${runId}:user`);
}

/** The reply to the prompt at `at`: the message, or null when there's none yet. */
export function replyAfter(messages, at) {
  let first = null, last = null;
  for (const m of messages.slice(at + 1)) {
    if (m?.role === 'user' && m.provenance?.kind === 'internal_system') continue; // the gateway's own "continue" turn
    if (m?.role === 'user') break;
    if (m?.role !== 'assistant' || !textOf(m).trim()) continue;
    last = m;
    if (!first && m.stopReason === 'stop') first = m;
  }
  return first || last;
}
