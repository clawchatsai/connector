# Local Deploy & Release Guide

How to build the connector, install it into a local OpenClaw gateway for development, and cut an npm release.

## Build

```bash
cd ~/connector
npm run build
```

This runs `tsc` and emits the TypeScript output to `dist/`. The `server/` directory is plain ESM JavaScript and is not compiled — it is loaded by the plugin wrapper at runtime.

## Install into a local OpenClaw gateway

After building, copy the plugin into the OpenClaw extensions directory and restart the gateway:

```bash
# Copy the compiled plugin
cp -r ~/connector/dist/*.js   ~/.openclaw/extensions/connector/

# Copy the runtime server (plain JS, not compiled)
cp -r ~/connector/server      ~/.openclaw/extensions/connector/

# Restart the gateway so it picks up the new build
openclaw gateway restart
```

The gateway will load the plugin on startup. Check the gateway logs to confirm the plugin registered — the version printed there should match the `version` field in `package.json`.

## Versioning

There is **one source of truth** for the plugin version: the `version` field in `package.json`.

- `src/index.ts` re-exports it as `PLUGIN_VERSION` (imported from `package.json` at build time). All runtime code that reports a version — signaling handshake, gateway registration, status output — pulls from this single constant.
- To bump the version, edit `package.json`, rebuild, and release. Do not hard-code versions anywhere else in the codebase.

### Minimum-version gating (frontend side)

The ClawChats frontend enforces a minimum connector version via a `MIN_PLUGIN_VERSION` constant in its `app.js`. The frontend rejects handshakes from plugins older than that value.

Implications when making breaking wire-level changes:

1. Bump `package.json` and land the change.
2. Publish the new connector version to npm (see below).
3. **Only then** bump `MIN_PLUGIN_VERSION` on the frontend to require the new version.

Doing it in the reverse order will brick the frontend for every user — it would require a version that has not been published yet.

## npm Release

The package (`@clawchatsai/connector`) is published via GitHub Actions. **Do not run `npm publish` manually.**

### Release flow

```bash
cd ~/connector

# 1. Commit the version bump and any release changes
git add -A
git commit -m "Release vX.Y.Z"

# 2. Tag the release
git tag vX.Y.Z

# 3. Push commits and tags together
git push origin main --tags
```

Pushing the tag triggers the GitHub Actions workflow, which runs the build and publishes to npm. Verify the release after the workflow completes:

```bash
npm view @clawchatsai/connector version
```

It should return `X.Y.Z`.

### Pre-release checks

Before tagging:

- `npm run build` succeeds locally with no TypeScript errors.
- The version in `package.json` matches the tag you are about to push (`vX.Y.Z` tag ↔ `"version": "X.Y.Z"`).
- The change has been installed into a local OpenClaw gateway (`~/.openclaw/extensions/connector/`) and exercised end-to-end with the frontend.

## Troubleshooting

### Plugin does not appear in gateway after restart
Gateway reads extensions from `~/.openclaw/extensions/`. Confirm the files were copied into `~/.openclaw/extensions/connector/` (not a sibling directory) and that `openclaw.plugin.json` is present.

### Version shown by gateway does not match what you built
Stale files in the extensions directory. Remove `~/.openclaw/extensions/connector/` entirely, rebuild, and copy fresh.

### GitHub Actions publish failed
Check the Actions tab on the repository. Common causes: version already published (tag a new version), npm auth token expired, or build failure in CI.
