import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../bootstrap/native.js';
import { ContactBook } from './contacts.js';
import { noteCandidates, checkRepoDoc, resolvePicks, syncNotes, removeNotes, picksSignature } from './notes-sync.js';
import { olderThan, peerOutdated, outdatedMessage, MIN_PEER_VERSION } from './version.js';

const book = () => { const db = new Database(':memory:'); return new ContactBook(() => db); };

test('a contact is per person (email, any case); settings save one field at a time, validated', () => {
  const b = book();
  b.create('Kamil@X.dev', { name: 'Kamil' });
  assert.equal(b.get('kamil@x.dev').name, 'Kamil');
  assert.equal(b.create('kamil@x.dev', { access: 'full' }).access, 'trusted', 'create never overwrites');
  assert.throws(() => b.set('kamil@x.dev', 'access', 'root'), /Unknown access/);
  assert.throws(() => b.set('kamil@x.dev', 'autonomy', 'wild'), /Unknown autonomy/);
  assert.throws(() => b.set('kamil@x.dev', 'nope', 1), /Unknown setting/);
  assert.equal(b.set('kamil@x.dev', 'private', 'health').private, 'health');
  assert.deepEqual(b.set('kamil@x.dev', 'mcp', { gmail: 1, x: 0 }).mcp, { gmail: true, x: false });
});

test('Access resets Tools and Commands to that tier; Full needs confirming once', () => {
  const b = book();
  b.create('k@x.dev');
  b.set('k@x.dev', 'tools', ['read']);
  assert.equal(b.set('k@x.dev', 'access', 'restricted').commands, 'basic');
  assert.throws(() => b.set('k@x.dev', 'access', 'full'), e => e.code === 'confirm_full');
  const full = b.set('k@x.dev', 'access', 'full', { confirmFull: true });
  assert.ok(full.fullConfirmedAt);
  assert.deepEqual(full.tools.sort(), ['memory_get', 'memory_search', 'pdf', 'view_image', 'web_fetch', 'web_search']);
  b.set('k@x.dev', 'access', 'trusted');
  assert.equal(b.set('k@x.dev', 'access', 'full').access, 'full', 'confirmed once');
});

test('"Open one folder" is Full agent only and needs Commands "ask me"; Basic list entries are checked', () => {
  const b = book();
  b.create('k@x.dev');
  assert.throws(() => b.set('k@x.dev', 'openFolder', '/w/plans'), /Full agent/);
  b.set('k@x.dev', 'access', 'full', { confirmFull: true });
  b.set('k@x.dev', 'commands', 'basic');
  assert.throws(() => b.set('k@x.dev', 'openFolder', '/w/plans'), /ask me/);
  b.set('k@x.dev', 'commands', 'ask');
  assert.equal(b.set('k@x.dev', 'openFolder', '/w/plans').openFolder, '/w/plans');
  assert.throws(() => b.set('k@x.dev', 'commands', 'basic'), /ask me/);
  assert.throws(() => b.set('k@x.dev', 'basicList', [{ pattern: 'env' }]), e => e.code === 'bad_entry');
  assert.equal(b.set('k@x.dev', 'basicList', [{ pattern: 'hostname' }]).basicList[0].pattern, 'hostname');
  assert.equal(b.set('k@x.dev', 'basicList', null).basicList, null, 'back to the defaults');
});

test('one counter per person: day and hour windows, per tier; a failed reply gives its count back', () => {
  const b = book();
  b.create('k@x.dev');
  const now = Date.UTC(2026, 10, 20, 10, 30);
  b.count('k@x.dev', 49, now);
  assert.equal(b.overCap('k@x.dev', 'bounded', now), null);
  b.count('k@x.dev', 1, now);
  assert.match(b.overCap('k@x.dev', 'bounded', now), /Daily limit reached \(50/);
  assert.match(b.overCap('k@x.dev', 'extended', now), /Hourly limit reached \(12/);
  assert.equal(b.overCap('k@x.dev', 'extended', now + 3_600_000), null, 'next hour');
  b.count('k@x.dev', -1, now);
  assert.equal(b.usage('k@x.dev', now).day, 49);
  b.forget('k@x.dev');
  assert.equal(b.get('k@x.dev'), null);
  assert.equal(b.usage('k@x.dev', now).day, 0);
});

test('notes: only top-level memory/projects/*.md are offered; infrastructure notes start off', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  fs.mkdirSync(path.join(ws, 'memory/projects/sub'), { recursive: true });
  for (const f of ['clawchats.md', 'homelab.md', 'openclaw-gateway-ops.md', 'vault-notes.md', 'sub/deep.md']) fs.writeFileSync(path.join(ws, 'memory/projects', f), `# ${f}`);
  fs.writeFileSync(path.join(ws, 'memory/2026-11-20.md'), 'daily');
  fs.writeFileSync(path.join(ws, 'MEMORY.md'), 'private');
  const c = noteCandidates([ws]);
  assert.deepEqual(c.map(x => [x.name, x.defaultOn]), [['clawchats.md', true], ['homelab.md', false], ['openclaw-gateway-ops.md', false], ['vault-notes.md', false]]);
  // Picks that aren't candidates or allowed repo docs are dropped (MEMORY.md, a daily note).
  assert.deepEqual(resolvePicks([path.join(ws, 'MEMORY.md'), path.join(ws, 'memory/2026-11-20.md'), c[0].path], c).map(f => f.dest), ['clawchats.md']);
});

test('notes sync: read-only copies, secrets removed, no symlinks followed, re-synced when a note changes, removed on None', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const copyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-'));
  fs.mkdirSync(path.join(ws, 'memory/projects'), { recursive: true });
  const note = path.join(ws, 'memory/projects/clawchats.md');
  fs.writeFileSync(note, 'Deploy key: ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx\nStack: node');
  const files = resolvePicks([note], noteCandidates([ws]));
  const r = syncNotes(copyWs, files);
  assert.deepEqual([r.files, r.secretsRemoved], [1, 1]);
  const out = path.join(copyWs, 'notes/clawchats.md');
  assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /sk-ant/);
  assert.equal(fs.statSync(out).mode & 0o777, 0o444);
  const sig = picksSignature(files);
  fs.writeFileSync(note, 'Stack: node 24', { flag: 'w' });
  fs.utimesSync(note, new Date(), new Date(Date.now() + 5000));
  assert.notEqual(picksSignature(files), sig, 'an edit shows as a new signature');
  syncNotes(copyWs, files);
  assert.equal(fs.readFileSync(out, 'utf8'), 'Stack: node 24');
  // A source that turned into a link is skipped.
  fs.rmSync(note); fs.symlinkSync('/etc/hostname', note);
  assert.equal(syncNotes(copyWs, files).files, 0);
  removeNotes(copyWs);
  assert.equal(fs.existsSync(path.join(copyWs, 'notes')), false);
});

test('repo docs: a .md in a git repo, never under ~/.openclaw, never through a link', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = path.join(home, 'repos/app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'));
  fs.writeFileSync(path.join(repo, 'specs/a.md'), '# a');
  fs.writeFileSync(path.join(repo, 'secret.json'), '{}');
  fs.mkdirSync(path.join(home, '.openclaw/workspace/.git'), { recursive: true });
  fs.writeFileSync(path.join(home, '.openclaw/workspace/x.md'), '# x');
  fs.symlinkSync(path.join(repo, 'specs/a.md'), path.join(repo, 'link.md'));
  const ok = checkRepoDoc('~/repos/app/specs/a.md', { home });
  assert.deepEqual([ok.ok, ok.repo, ok.name], [true, repo, 'app/specs/a.md']);
  assert.match(checkRepoDoc(path.join(repo, 'secret.json'), { home }).error, /Markdown/);
  assert.match(checkRepoDoc(path.join(home, '.openclaw/workspace/x.md'), { home }).error, /openclaw/);
  assert.match(checkRepoDoc(path.join(repo, 'link.md'), { home }).error, /link/);
  assert.match(checkRepoDoc(path.join(repo, 'specs/../../app/specs/a.md'), { home }).ok ? 'ok' : 'x', /ok/, 'normalized');
  assert.match(checkRepoDoc('specs/a.md', { home }).error, /full path/);
});

test('peer versions: older than the minimum, or none at all, is too old; the message names the update command', () => {
  assert.equal(olderThan('0.2.4', '0.3.0'), true);
  assert.equal(olderThan('0.3.0', '0.3.0'), false);
  assert.equal(olderThan('0.10.0', '0.3.0'), false);
  assert.equal(peerOutdated(null), true);
  assert.equal(peerOutdated('0.2.4'), true);
  assert.equal(peerOutdated(MIN_PEER_VERSION), false);
  assert.match(outdatedMessage('Kamil', '0.2.4'), /Kamil's ClawChats connector is out of date \(0\.2\.4\)[^]*openclaw plugins install npm:@clawchatsai\/connector --force/);
  assert.match(outdatedMessage(null, null), /^Your ClawChats connector is out of date\./);
});

test('Auto-review is gone for contacts: a stored "auto" reads as ask, and setting it (an older card) gives ask', () => {
  const b = book();
  b.create('k@x.dev');
  assert.equal(b.set('k@x.dev', 'commands', 'auto').commands, 'ask');
  b.db().prepare("UPDATE peer_contact SET commands = 'auto'").run();
  assert.equal(b.get('k@x.dev').commands, 'ask');
});
