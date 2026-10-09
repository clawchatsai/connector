#!/usr/bin/env node
// Downloads node-datachannel's prebuilt WebRTC binary for every platform we support into
// prebuilds/<platform>/node_datachannel.node, so one npm package works everywhere.
// Fails if any platform is missing: a silently skipped platform ships a connector that
// cannot start for those users.
//
//   node scripts/fetch-prebuilds.mjs                 all platforms (release)
//   node scripts/fetch-prebuilds.mjs linux-x64 ...   only these (local testing)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { PLATFORMS } from './platforms.mjs';
const MIN_BINARY_BYTES = 1_000_000; // a truncated download or an HTML error page is far smaller

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(root, 'package.json'));
const ndcMain = require.resolve('node-datachannel');
const ndcPkg = JSON.parse(fs.readFileSync(path.join(ndcMain.slice(0, ndcMain.lastIndexOf(`${path.sep}node-datachannel${path.sep}`) + '/node-datachannel'.length), 'package.json'), 'utf8'));
const version = ndcPkg.version;
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : PLATFORMS;

const failures = [];
for (const platform of wanted) {
  const url = `https://github.com/murat-dogan/node-datachannel/releases/download/v${version}/node-datachannel-v${version}-napi-v8-${platform}.tar.gz`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-'));
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(path.join(work, 'a.tar.gz'), Buffer.from(await res.arrayBuffer()));
    execFileSync('tar', ['-xzf', path.join(work, 'a.tar.gz'), '-C', work]);
    const found = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : f.endsWith('.node') && found.push(f); } })(work);
    if (!found.length) throw new Error('no .node file in archive');
    if (fs.statSync(found[0]).size < MIN_BINARY_BYTES) throw new Error('binary is implausibly small');
    const dest = path.join(root, 'prebuilds', platform);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(found[0], path.join(dest, 'node_datachannel.node'));
    console.log(`ok   ${platform}`);
  } catch (e) {
    failures.push(`${platform}: ${e.message}`);
    console.error(`FAIL ${platform}: ${e.message}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error(`\n${failures.length} platform(s) missing node-datachannel v${version}:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`prebuilds ready for node-datachannel v${version}`);
