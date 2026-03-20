import fs from 'node:fs';
import path from 'node:path';

export class DebugLogger {
  constructor(baseDir) {
    this.baseDir = path.join(baseDir, '..', 'debug');
    this.active = false;
    this.sessionId = null;
    this.wsStream = null;
    this.originatingClient = null;
  }

  start(ts, originatingClient) {
    if (this.active) return { error: 'already-active', sessionId: this.sessionId };
    this.sessionId = ts.replace(/[:.]/g, '-');
    this.originatingClient = originatingClient;
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.wsStream = fs.createWriteStream(path.join(this.baseDir, `session-${this.sessionId}-ws.log`), { flags: 'a' });
    this.active = true;
    console.log(`Debug recording started: ${this.sessionId}`);
    return { sessionId: this.sessionId };
  }

  logFrame(direction, data) {
    if (this.active && this.wsStream) this.wsStream.write(`${new Date().toISOString()} ${direction} ${data}\n`);
  }

  saveDump(payload) {
    if (!this.sessionId) return { sessionId: null, files: [] };
    const files = [];
    const id = this.sessionId;
    if (this.wsStream) { this.wsStream.end(); this.wsStream = null; files.push(`session-${id}-ws.log`); }

    let logContent = '';
    for (const entry of (payload.console || [])) {
      logContent += `${entry.ts} [${entry.level.toUpperCase()}] ${entry.args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
    }
    for (const err of (payload.errors || [])) logContent += `${err.ts} [UNHANDLED] ${err.message}\n${err.stack || ''}\n`;
    if (logContent) { fs.writeFileSync(path.join(this.baseDir, `session-${id}-client.log`), logContent); files.push(`session-${id}-client.log`); }
    if (payload.state) { fs.writeFileSync(path.join(this.baseDir, `session-${id}-state.json`), JSON.stringify(payload.state, null, 2)); files.push(`session-${id}-state.json`); }
    if (payload.screenshot) { fs.writeFileSync(path.join(this.baseDir, `session-${id}-screenshot.jpg`), Buffer.from(payload.screenshot, 'base64')); files.push(`session-${id}-screenshot.jpg`); }

    const savedId = id;
    this.active = false; this.sessionId = null; this.originatingClient = null;
    console.log(`Debug session saved: ${files.join(', ')}`);
    return { sessionId: savedId, files };
  }

  handleClientDisconnect(ws) {
    if (this.active && this.originatingClient === ws) {
      console.log(`Debug session ${this.sessionId} auto-closed: client disconnected`);
      if (this.wsStream) { this.wsStream.write(`${new Date().toISOString()} SYSTEM Client disconnected — session auto-closed\n`); this.wsStream.end(); this.wsStream = null; }
      this.active = false; this.sessionId = null; this.originatingClient = null;
    }
  }
}
