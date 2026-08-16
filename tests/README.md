# API contract tests

`tests/api/` — per-endpoint coverage for the HTTP backend in `server/`:
request/response shapes, validation, error paths, persistence and workspace
isolation.

`tests/plugin/` — pure decision functions from the TypeScript plugin in `src/`,
where getting the answer wrong is a security defect rather than a wrong
response body. These import from `dist/`, so `npm test` runs `npm run build`
first (`pretest`); anything needing a live DataChannel or WebRTC belongs in
ClawChats' compose suite, not here.

`tests/bench-delete-guard.mjs` — not a test and not in the suite (the runner
globs `*.test.mjs`). It measures what the cross-workspace uploads guard costs a
`DELETE /api/threads/:id` across a range of workspace counts, so the numbers
quoted for CLA-1419 can be re-derived rather than trusted.

```bash
npm test                                  # whole suite (builds first)
node --test tests/api/threads.test.mjs    # one file
node tests/bench-delete-guard.mjs         # delete-guard cost, not part of the suite
```

## Why these live here

The ClawChats frontend repo used to carry a Playwright suite that asserted
against this backend. When the backend moved out, the assertions stayed behind
and kept failing against a server that no longer existed, until someone deleted
all 72 of them. The tests described a contract that shipped from a different
repo, and nothing forced the two to move together.

So the split is:

| Coverage | Home |
|---|---|
| Frontend state machines | ClawChats, Playwright project `frontend` |
| Seam: login → thread → message persists → unread | ClawChats, Playwright project `e2e-compose` |
| **Per-endpoint contract, validation, error paths** | **here** |

Anything requiring a browser, a live gateway, or the compose stack belongs in
ClawChats, not in this directory.

## Design constraints

**No dependencies.** The runner is `node --test` and the assertions are
`node:assert/strict`, both built in. Adding a framework here means a new install
step on the release gate, so don't.

**In-process, no gateway.** `createApp()` in `server/index.js` is a pure factory:
importing it starts nothing, the gateway WebSocket is only dialled by an explicit
`connect()` the harness never calls, and SQLite is `node:sqlite` rather than a
native module. A test therefore needs nothing but a temp directory — no compose
stack, no `npm rebuild`, no credentials. The full suite runs in well under a
second. Keep it that way.

Because the gateway is never connected, a send with no connection logs and
returns rather than throwing. Routes that would relay to the gateway still
perform their database write and still answer — that persistence is the thing
under test.

**Isolation.** `startTestServer()` gives every suite its own data and uploads
directories and an ephemeral port, and `close()` removes them. Use a fresh
server per `describe` rather than sharing state across tests. If a test needs to
assert that a file is *absent*, root it in a directory the test creates itself —
asserting against a shared temp root passes or fails on leftovers from earlier
runs.

**Tests must exit cleanly.** `npm test` runs without `--test-force-exit`, so a
leaked timer or socket is a failure, not an inconvenience. If the suite hangs,
something is holding the event loop open — find it rather than forcing exit.

## What runs them

- `npm test` locally.
- `prepublishOnly` in `package.json` — a failing suite blocks `npm publish`.
- Per-change CI is prepared in `docs/ci/test-workflow.yml` but **not yet
  active**; see the header of that file for why and how to install it.
