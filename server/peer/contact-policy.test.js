import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultContact, copyTools, copyToolsHold, effectiveTools, sessionMode, approvalsEntry, validateBasicEntry, basicList, gitEntries, toolOverrides, topicsNote, ALWAYS_OFF, copySlug } from './contact-policy.js';

test('tier defaults: Restricted = Basic only, Trusted = Basic + ask me, Full = Basic + ask me; autonomy Bounded; default skills', () => {
  assert.deepEqual([defaultContact('restricted').commands, defaultContact('trusted').commands, defaultContact('full').commands], ['basic', 'ask', 'ask']);
  assert.equal(defaultContact().access, 'trusted');
  assert.equal(defaultContact().autonomy, 'bounded');
  assert.equal(defaultContact().knowledge, 'notes');
  assert.deepEqual(defaultContact().skills, ['weather', 'diagram-maker', 'visualize']);
});

test('a copy is an allowlist on the minimal profile: ticked tools only, the always-off list and the owner\'s accounts denied', () => {
  for (const access of ['restricted', 'trusted', 'full']) {
    const t = copyTools(defaultContact(access));
    assert.equal(t.profile, 'minimal');
    assert.equal(t.fs.workspaceOnly, true);
    assert.deepEqual(t.openclaw, { autoApproveChanges: false });
    assert.equal(t.exec.strictInlineEval, true);
    for (const x of ALWAYS_OFF) { assert.ok(t.deny.includes(x), `${access}: ${x} denied`); assert.ok(!t.alsoAllow.includes(x)); }
    for (const x of ['message', 'browser', 'nodes', 'computer', 'talk_voice', 'cron', 'sessions_list']) assert.ok(t.deny.includes(x), `${access}: ${x}`);
  }
  const r = copyTools(defaultContact('restricted'));
  assert.deepEqual(r.alsoAllow, ['exec', 'pdf', 'process', 'read', 'view_image']);
  assert.ok(r.deny.includes('write') && r.deny.includes('web_search'));
  assert.equal(r.exec.mode, 'allowlist');
  const tr = copyTools(defaultContact('trusted'));
  assert.ok(['write', 'edit', 'apply_patch', 'web_search', 'web_fetch'].every(x => tr.alsoAllow.includes(x)));
  assert.ok(!tr.deny.includes('group:fs') && !tr.deny.includes('group:web'), 'a ticked tool lifts its group deny');
  assert.equal(tr.exec.mode, 'ask');
});

test('Full agent: memory read-only (no write tools ever), no file tools unless one folder is opened', () => {
  const c = { ...defaultContact('full'), tools: ['read', 'write', 'memory_search', 'memory_get'] };
  assert.deepEqual(effectiveTools(c), ['memory_get', 'memory_search']);
  const t = copyTools(c);
  for (const x of ['read', 'write', 'edit', 'apply_patch']) assert.ok(t.deny.includes(x), x);
  assert.ok(!t.deny.includes('group:plugins'), 'memory-core tools are plugin tools');
  assert.deepEqual(effectiveTools({ ...c, openFolder: '/w/plans' }), ['memory_get', 'memory_search', 'read']);
  assert.deepEqual(effectiveTools({ ...c, tools: ['memory_get'], openFolder: '/w/plans' }), ['memory_get', 'read'], 'opening a folder is what allows read');
  // Copies (Restricted/Trusted) never get the owner's memory tools, whatever is ticked.
  assert.deepEqual(effectiveTools({ ...defaultContact('trusted'), tools: ['memory_search', 'read'] }), ['read']);
});

test('Commands tiers: session mode and copy exec mode (Basic only runs with no session mode, spike run 2)', () => {
  const at = commands => ({ ...defaultContact('trusted'), commands });
  assert.deepEqual(['off', 'basic', 'ask', 'auto'].map(c => sessionMode(at(c))), [null, null, 'guarded', 'workspace']);
  assert.deepEqual(['off', 'basic', 'ask', 'auto'].map(c => copyTools(at(c)).exec.mode), ['deny', 'allowlist', 'ask', 'auto']);
  const off = copyTools(at('off'));
  assert.ok(off.deny.includes('exec') && !off.alsoAllow.includes('exec'));
  assert.deepEqual(copyTools(at('auto'), { reviewerModel: 'anthropic/claude-haiku-4-5' }).exec.reviewer, { model: 'anthropic/claude-haiku-4-5' });
  assert.equal(copyTools(at('ask'), { reviewerModel: 'x' }).exec.reviewer, undefined);
  assert.deepEqual(approvalsEntry(at('basic')).ask, 'off');
  assert.deepEqual(approvalsEntry(at('ask')).ask, 'on-miss');
  assert.equal(approvalsEntry(at('off')).security, 'deny');
  assert.equal(approvalsEntry(at('basic')).autoAllowSkills, false);
  assert.equal(approvalsEntry(at('basic')).askFallback, 'deny');
});

test('basic list: anchored patterns, git per picked repo, no openclaw status', () => {
  const e = approvalsEntry({ ...defaultContact('restricted'), repos: ['/home/k/repos/clawchats'] });
  const oc = e.allowlist.find(x => x.pattern === 'openclaw');
  assert.ok(new RegExp(oc.argPattern).test('--version'));
  assert.ok(!new RegExp(oc.argPattern).test('status'));
  const cat = new RegExp(e.allowlist.find(x => x.pattern === 'cat').argPattern);
  assert.ok(cat.test('/etc/os-release') && !cat.test('/home/k/.openclaw/openclaw.json'));
  const git = new RegExp(e.allowlist.find(x => x.pattern === 'git').argPattern);
  assert.ok(git.test('-C /home/k/repos/clawchats log --oneline -n 5'));
  assert.ok(git.test('-C /home/k/repos/clawchats status -s'));
  assert.ok(!git.test('-C /home/k/repos/other log'));
  assert.ok(!git.test('-C /home/k/repos/clawchats show HEAD:.env'));
  assert.ok(e.allowlist.every(x => !x.argPattern || (x.argPattern.startsWith('^') && x.argPattern.endsWith('$'))));
  assert.equal(gitEntries(['relative/path']).length, 0);
});

test('Edit list refuses risky commands without an exact pattern, and warns on .openclaw', () => {
  for (const cmd of ['cat', 'env', 'printenv', 'bash', 'sh', 'python3', 'node', 'curl', 'wget', 'ssh', 'openclaw']) {
    assert.equal(validateBasicEntry({ pattern: cmd }).ok, false, cmd);
    assert.equal(validateBasicEntry({ pattern: cmd, argPattern: '^.*$' }).ok, false, `${cmd} with .*`);
  }
  assert.equal(validateBasicEntry({ pattern: 'cat', argPattern: '^/etc/hostname$' }).ok, true);
  assert.equal(validateBasicEntry({ pattern: '/bin/ls' }).ok, false, 'no paths');
  assert.equal(validateBasicEntry({ pattern: 'ls*' }).ok, false, 'no globs');
  assert.equal(validateBasicEntry({ pattern: 'hostname' }).ok, true);
  assert.match(validateBasicEntry({ pattern: 'hostname' }).warning, /Any arguments/);
  assert.match(validateBasicEntry({ pattern: 'cat', argPattern: '^/home/k/\\.openclaw/x$' }).warning, /\.openclaw/);
  assert.equal(validateBasicEntry({ pattern: 'uptime', argPattern: '(' }).ok, false);
  // A stored list keeps only valid entries.
  assert.deepEqual(basicList({ basicList: [{ pattern: 'env' }, { pattern: 'uptime', argPattern: '^$' }], repos: [] }).map(x => x.pattern), ['uptime']);
});

test('session overrides: every known skill and MCP server set explicitly (new ones start off); web search follows the tick', () => {
  const c = { ...defaultContact('trusted'), mcp: { 'chrome-devtools': true }, mcpToolsDeny: { 'chrome-devtools': ['evaluate_script'], gmail: ['x'] } };
  assert.deepEqual(toolOverrides(c, { skillNames: ['weather', 'github'], mcpServers: ['gmail', 'chrome-devtools'] }), {
    webSearch: true, skills: { github: false, weather: true },
    mcpServers: { 'chrome-devtools': true, gmail: false }, mcpToolsDeny: { 'chrome-devtools': ['evaluate_script'] },
  });
  assert.deepEqual(toolOverrides(defaultContact('restricted')), { webSearch: false });
  assert.ok(copyTools(c).alsoAllow.includes('bundle-mcp'), 'an MCP server on needs its plugin tools allowed');
  assert.ok(!copyTools(defaultContact('trusted')).alsoAllow.includes('bundle-mcp'));
});

test('Private / Always fine become one instruction line; nothing when both are empty', () => {
  assert.equal(topicsNote(defaultContact(), 'Kamil'), '');
  const n = topicsNote({ private: 'my health', alwaysFine: 'OpenClaw' }, 'Kamil');
  assert.match(n, /private from Kamil[^]*my health/);
  assert.match(n, /share these with Kamil freely: OpenClaw/);
});

test('a copy holds its policy only while nothing was widened; ids are per person', () => {
  const want = copyTools(defaultContact('trusted'));
  assert.equal(copyToolsHold(JSON.parse(JSON.stringify(want)), want), true);
  assert.equal(copyToolsHold({ ...want, alsoAllow: [...want.alsoAllow, 'message'] }, want), false);
  assert.equal(copyToolsHold({ ...want, deny: want.deny.filter(x => x !== 'gateway') }, want), false);
  assert.equal(copyToolsHold({ ...want, exec: { ...want.exec, mode: 'full' } }, want), false);
  assert.equal(copyToolsHold({ ...want, fs: {} }, want), false);
  assert.notEqual(copySlug('kamil@a.dev'), copySlug('kamil@b.dev'));
  assert.match(copySlug('Kamil.G@x.dev'), /^kamil-g-[0-9a-f]{4}$/);
});
