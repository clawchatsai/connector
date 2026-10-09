// Platforms the connector ships a prebuilt node-datachannel binary for. Keys match
// getPrebuildKey() in src/index.ts (`<platform>-<arch>`, `linuxmusl-<arch>` on musl).
export const PLATFORMS = [
  'linux-x64', 'linux-arm64', 'linux-arm',
  'linuxmusl-x64', 'linuxmusl-arm64',
  'darwin-x64', 'darwin-arm64',
  'win32-x64', 'win32-arm64',
];
