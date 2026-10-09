# Fresh-install test

Proves `openclaw plugins install` of the connector works on a clean machine: a new Linux user, OpenClaw
installed the documented way (`install-cli.sh`, user-space Node), no prior ClawChats state.

```bash
# on a Docker host (arm64 needs qemu-user-binfmt)
docker build --platform linux/amd64 -t ccx-debian-x64 scripts/e2e-install                 # glibc
docker build --platform linux/arm64 -t ccx-debian-arm64 scripts/e2e-install               # arm64
docker build --platform linux/amd64 --build-arg BASE=node:24-alpine -t ccx-alpine-x64 scripts/e2e-install  # musl

npm run build && node scripts/fetch-prebuilds.mjs && npm pack --ignore-scripts   # -> clawchatsai-connector-<v>.tgz
docker run --rm --platform linux/amd64 \
  -v $PWD/scripts/e2e-install/run-test.sh:/home/tester/run-test.sh:ro \
  -v $PWD/clawchatsai-connector-<v>.tgz:/tmp/connector.tgz:ro \
  ccx-debian-x64 /tmp/connector.tgz
```

Pass = the install prints `Applied in Gateway generation N`, `status` says *waiting for setup*, and after
the simulated setup `status` shows `Gateway: connected` with the WebRTC binary installed from `prebuilds/`.
Pass an npm spec (`@clawchatsai/connector@x.y.z`) instead of a tarball path to test a published release.
macOS and Windows are not covered here.
