// Is the owner at a ClawChats window right now? Each signed-in browser reports { visible, focused, idleMs,
// sessionKey } over its DataChannel (on visibility change, chat switch, and at most every ~30 s while used).
// Present = some window is visible and had user input within the last 2 minutes. A closed channel is away.

export const PRESENT_IDLE_MS = 2 * 60_000;

export class Presence {
  constructor({ idleMs = PRESENT_IDLE_MS, now = Date.now } = {}) {
    this.idleMs = idleMs;
    this.now = now;
    this.clients = new Map(); // connectionId -> { visible, focused, lastActiveAt, sessionKey }
  }

  update(connectionId, msg) {
    const idle = Number.isFinite(msg?.idleMs) ? Math.max(0, msg.idleMs) : this.idleMs; // received clock, not the device's
    this.clients.set(connectionId, {
      visible: msg?.visible === true,
      focused: msg?.focused === true,
      lastActiveAt: this.now() - idle,
      sessionKey: typeof msg?.sessionKey === 'string' ? msg.sessionKey.slice(0, 512) : null,
    });
  }

  remove(connectionId) { this.clients.delete(connectionId); }

  isPresent() {
    const now = this.now();
    for (const c of this.clients.values()) if (c.visible && now - c.lastActiveAt < this.idleMs) return true;
    return false;
  }
}
