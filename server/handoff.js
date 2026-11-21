// Secret hand-off: the `handoff` agent tool. Reads one HANDOFF_* entry of the gateway's protected secret store in this
// process and serves it once through a named pipe, so the agent runs `cmd < <fifo>` without the value entering its
// context, the transcript or a file.
//
// The value enters through the stock `secrets` request prompt (OpenClaw has no plugin-owned masked question; the
// gateway rejects masked questions not bound to the store). The HANDOFF_ prefix is the contract between the two halves:
// ClawChats labels such a prompt "Local hand-off" (and stores it with no allowed hosts), and this tool serves nothing
// else, so it can't pipe out the web keys the egress proxy keeps from the agent.
//
// Guards against accidental exposure, not against the agent: whoever opens the pipe gets the value (`cat fifo` prints
// it). Every request and delivery is audited with the opener's command line, never the value.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const NAME_RE = /^HANDOFF_[A-Z0-9_]{1,120}$/;
export const TTL_MS = 10 * 60_000;
const POLL_MS = 50;
const MAX_BYTES = 65_536; // one non-blocking write into an empty pipe (Linux default pipe capacity)

const DESCRIPTION = [
  'Password typed into a command on this machine (vault unlock, CLI login, sudo, ssh, database client) -> handoff with a',
  'HANDOFF_* entry. Not for API keys: a key for a web API or HTTPS service (OpenAI, Stripe, a weather API) is a web key,',
  'requested with `secrets` under a plain name (OPENWEATHER_API_KEY, never HANDOFF_) and allowedHosts set to its host.',
  'Never ask for a password or key in chat.',
  'handoff({ name: "HANDOFF_<WHAT>", reason: "<command it goes into>" }) returns a named pipe that yields the stored value once,',
  'for `cmd < <fifo>` in exec, so the value never enters your context.',
  'Recipe:',
  '1. Only if `secrets list` lacks the entry: `secrets request` with name HANDOFF_<WHAT>, allowedHosts [] and a reason that',
  'starts "Hand-off:" and says which command gets it and whether it is deleted after use or kept for reuse.',
  'An existing entry is ready: never request it again.',
  '2. Call handoff, then run `cmd < <fifo>` (or a --password-file <fifo> option; for a command that only reads its environment,',
  '`PGPASSWORD="$(cat <fifo>)" psql ...` in that same command) with exec. The pipe is readable once and is removed after',
  '10 minutes. Never print, tee or copy it into a file, an exported variable or an argument.',
  '3. One-off values: `secrets delete` the entry right after the command succeeds. Long-lived ones (a vault password):',
  'keep the entry and call handoff again next time.',
  'A command that fails after opening the pipe has used it up: call handoff again for a fresh pipe.',
].join(' ');

const PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['name', 'reason'],
  properties: {
    name: { type: 'string', pattern: NAME_RE.source, description: 'Secret store entry name, HANDOFF_<WHAT>' },
    reason: { type: 'string', maxLength: 200, description: 'The command the value is piped into, for the audit log' },
  },
};

const readCmdline = pid => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 300); } catch { return '?'; }
};

/** The processes that have `fifo` open right now, each with its parent's command line (the exec command for `cmd < fifo`). */
export function openers(fifo) {
  const ino = fs.statSync(fifo).ino, out = [];
  for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p) && Number(p) !== process.pid)) {
    let fds; try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let st; try { st = fs.statSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (st.ino !== ino || !st.isFIFO()) continue;
      let ppid = null; try { ppid = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]); } catch { /* gone */ }
      out.push({ pid: Number(pid), cmd: readCmdline(pid), parent: ppid ? readCmdline(ppid) : '?' });
      break;
    }
  }
  return out;
}

export const pipeRoot = () => path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'oc-handoff');

/** Remove pipes left behind by a gateway that stopped before they expired. */
export function sweep(root = pipeRoot(), now = Date.now()) {
  let dirs; try { dirs = fs.readdirSync(root); } catch { return 0; }
  let n = 0;
  for (const d of dirs.filter(x => x.startsWith('h-'))) {
    const dir = path.join(root, d);
    try { if (now - fs.statSync(dir).mtimeMs < TTL_MS) continue; fs.rmSync(dir, { recursive: true, force: true }); n++; } catch { /* raced */ }
  }
  return n;
}

/**
 * Serve `value` (a Buffer, zeroed afterwards) once through a new FIFO. `onDone({ fifo, outcome, bytes?, openers? })`
 * reports `read`, `expired` or `error`. The writer opens non-blocking and polls, so no libuv thread waits on a reader.
 */
export function serveOnce(value, { ttlMs = TTL_MS, root = pipeRoot(), onDone = () => {} } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
  const dir = fs.mkdtempSync(path.join(root, 'h-'));
  const fifo = path.join(dir, randomBytes(8).toString('hex'));
  execFileSync('mkfifo', ['-m', '600', fifo]); // Node has no mkfifo(2) binding
  let done = false;
  const finish = info => {
    if (done) return; done = true;
    clearInterval(poll); clearTimeout(expiry);
    try { fs.unlinkSync(fifo); } catch { /* already unlinked */ }
    try { fs.rmdirSync(dir); } catch { /* gone */ }
    value.fill(0);
    onDone({ fifo, ...info });
  };
  const poll = setInterval(() => {
    let fd;
    try { fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); }
    catch (e) { if (e.code !== 'ENXIO') finish({ outcome: 'error', error: e.code }); return; } // ENXIO: no reader yet
    clearInterval(poll);
    let who = []; try { who = openers(fifo); } catch { /* audit only */ }
    try { fs.unlinkSync(fifo); } catch { /* raced */ } // first: no second open can find the path
    let bytes = 0, error;
    try { bytes = fs.writeSync(fd, value); } catch (e) { error = e.code; }
    fs.closeSync(fd); // the reader gets EOF
    finish({ outcome: error ? 'error' : 'read', bytes, openers: who, ...(error ? { error } : {}) });
  }, POLL_MS);
  poll.unref?.();
  const expiry = setTimeout(() => finish({ outcome: 'expired' }), ttlMs); expiry.unref?.();
  return { fifo, expiresAtMs: Date.now() + ttlMs };
}

/** Append-only JSONL audit log (0600). Never pass it a value. */
export function auditLog(file) {
  return entry => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    } catch { /* auditing must not break the hand-off */ }
  };
}

/** The gateway's SDK resolver for a store SecretRef: the plugin alias first, else the running gateway's package. */
async function loadResolver() {
  try { return (await import('openclaw/plugin-sdk/secret-ref-runtime')).resolveSecretRefValues; } catch { /* no alias */ }
  let d = path.dirname(fs.realpathSync(process.argv[1]));
  for (let i = 0; i < 6; i++, d = path.dirname(d)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name === 'openclaw') {
        return (await import(path.join(d, 'dist/plugin-sdk/secret-ref-runtime.js'))).resolveSecretRefValues;
      }
    } catch { /* keep looking */ }
  }
  throw new Error('the gateway secret store is not reachable from this connector');
}

const result = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], details: obj });

/**
 * The tool descriptor (plugin tool factory v2). Offered only on the owner's own, unsandboxed turns: contact copies,
 * guests, channels from other people and sandboxed runs never get it (contact copies also deny it, ALWAYS_OFF).
 * A host without the owner bit (undefined) gets no tool.
 */
export function handoffTool({ resolve, audit, fallbackConfig = () => ({}), serve = serveOnce }) {
  return {
    contextVersion: 2,
    create(context) {
      if (context?.senderIsOwner !== true || context.sandboxed || context.sandbox) return null;
      return {
        name: 'handoff',
        label: 'Password hand-off',
        // always directly callable: behind Tool Search a direct call fails ("not found") and models fall back to a web-key
        // `secrets request`, which nothing on this machine can use (QA 2026-11-20)
        catalogMode: 'direct-only',
        description: DESCRIPTION,
        parameters: PARAMETERS,
        async execute(_id, params) {
          const name = String(params?.name ?? ''), reason = String(params?.reason ?? '').slice(0, 200);
          const who = { name, reason, agentId: context.agentId, sessionKey: context.sessionKey };
          if (!NAME_RE.test(name)) {
            audit({ ev: 'refused', ...who });
            return result({ status: 'refused', error: 'handoff serves only secret store entries named HANDOFF_<WHAT>; web keys stay with the egress proxy' });
          }
          const config = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? fallbackConfig();
          const provider = config?.secrets?.defaults?.store || 'default';
          let value;
          try {
            const map = await resolve([{ source: 'store', provider, id: name }], { config });
            value = [...map.values()][0];
          } catch { value = undefined; } // its message could quote store internals; the agent only needs "missing"
          if (typeof value !== 'string' || !value) {
            audit({ ev: 'missing', ...who });
            // where models decide the next step: say exactly which call, and the way out for a web key (QA 2026-11-20:
            // a model asked for the password in chat when `secrets` wasn't a direct tool)
            return result({
              status: 'missing',
              error: `${name} is not stored yet.`,
              next: `Call secrets with { action: "request", name: "${name}", allowedHosts: [], reason: "Hand-off: <command>; deleted after use" (or "kept for reuse") }`
                + ' (if secrets is not a direct tool, through dispatch_action with id "secrets"), then call handoff again. Never ask for the value in chat.'
                + ' If this is an API key for an HTTPS service, it is not a hand-off: request it without the HANDOFF_ prefix and with allowedHosts set to its hosts.',
            });
          }
          const buf = Buffer.from(value, 'utf8');
          value = null; // the resolver's string can't be zeroed; drop our reference to it
          if (buf.length > MAX_BYTES) { buf.fill(0); return result({ status: 'refused', error: `${name} is over ${MAX_BYTES} bytes` }); }
          context.assertInvocationCurrent?.();
          const { fifo, expiresAtMs } = serve(buf, { onDone: ({ outcome, ...info }) => audit({ ev: outcome === 'read' ? 'delivered' : outcome, name, ...info }) });
          audit({ ev: 'requested', ...who, fifo, bytes: buf.length });
          // the cleanup step models skip ("clean up" read as the pipe): say it where the next step is decided
          return result({
            status: 'ready', fifo, expiresAt: new Date(expiresAtMs).toISOString(), usage: `cmd < ${fifo}`,
            then: `One-off value: delete the entry with secrets delete ${name} once the command succeeds. Keep it only if it is meant for reuse.`,
          });
        },
      };
    },
  };
}

/** Register `handoff` with the gateway; the audit log is <state>/clawchats/handoff-audit.log. */
export function registerHandoff(api, { stateDir }) {
  if (process.platform !== 'linux' || typeof api.registerTool !== 'function') return; // /proc + mkfifo
  sweep();
  let resolver;
  const resolve = async (refs, opts) => (resolver ??= await loadResolver())(refs, opts);
  api.registerTool(handoffTool({ resolve, audit: auditLog(path.join(stateDir, 'clawchats', 'handoff-audit.log')), fallbackConfig: () => api.config ?? {} }), { name: 'handoff' });
}
