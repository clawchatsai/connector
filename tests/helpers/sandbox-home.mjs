// Redirect HOME at a throwaway directory for the current test process.
//
// This module has one job and it must run BEFORE anything imports
// server/config.js. That file captures `os.homedir()` into a module-level const
// at import time (`export const HOME`), and getSessionsDirForAgent() builds every
// sessions path from it — so a test that sets process.env.HOME *after* importing
// the server silently keeps resolving the developer's real ~/.openclaw. The
// sandbox would look applied while cleanGatewaySession() unlinked live
// transcripts, which is a silent-passing failure rather than a loud one.
//
// harness.mjs imports this for its side effect on the line above the server
// import, which makes the ordering unconditional: ESM evaluates a module's
// dependencies in source order, so this body runs first. Every suite that boots
// a test server therefore gets a sandboxed HOME without opting in.
//
// The blast radius is why this is worth the ceremony: the gateway session store
// is per *agent* and shared by every workspace on the machine, so getting it
// wrong destroys other people's live sessions, not just this suite's fixtures.
// node:test runs each file in its own process, so one sandbox per file is safe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-test-home-'));
process.env.HOME = sandboxHome;

/** Ensure and return the sessions directory config.js will resolve for `agent`. */
export function sandboxSessionsDir(agent = 'main') {
  const dir = path.join(sandboxHome, '.openclaw', 'agents', agent, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeSandboxHome() {
  fs.rmSync(sandboxHome, { recursive: true, force: true });
}
