#!/usr/bin/env node
// Release gate: checks the tarball `npm publish` would upload actually contains everything a
// fresh install needs, for every supported platform. Run after build + fetch-prebuilds.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PLATFORMS } from './platforms.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
const files = new Map(JSON.parse(out)[0].files.map(f => [f.path, f.size]));

const required = [
  'package.json', 'openclaw.plugin.json', 'dist/index.js', 'server/index.js',
  ...PLATFORMS.map(p => `prebuilds/${p}/node_datachannel.node`),
];
const problems = required.filter(f => !files.has(f)).map(f => `missing from package: ${f}`);
for (const p of PLATFORMS) {
  const size = files.get(`prebuilds/${p}/node_datachannel.node`);
  if (size !== undefined && size < 1_000_000) problems.push(`prebuilds/${p} is implausibly small (${size} bytes)`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`package ok: ${files.size} files, ${PLATFORMS.length} platforms`);
