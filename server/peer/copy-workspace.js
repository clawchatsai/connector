// The folder of an agent this connector made for someone else (a guest copy): what the gateway seeded into it that the
// copy must not run.
//
// `agents.create` gives a brand-new folder BOOTSTRAP.md, the gateway's first-run "birth sequence" (introduce yourself,
// ask what to call you, wait for the answer). A guest copy never finishes it, because it never writes its own identity,
// so every turn ran with it loaded (clawchats specs/bugs/2026-11-22-guest-copy-first-run.md). Removing the file is how
// the gateway itself retires it: a seeded folder without BOOTSTRAP.md counts as set up and isn't seeded again. The
// gateway has no RPC to delete an agent file, so it's done on disk, like the copy's notes (notes-sync.js).

import fs from 'node:fs';
import path from 'node:path';

const FIRST_RUN = 'BOOTSTRAP.md';

/** Remove the first-run file from a copy's own folder. Only a regular file; true when one was removed. Never throws. */
export function retireFirstRun(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return false;
  const file = path.join(workspace, FIRST_RUN);
  try {
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st?.isFile()) return false;
    fs.rmSync(file);
    return true;
  } catch { return false; }
}
