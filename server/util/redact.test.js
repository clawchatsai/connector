import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, REDACTED } from './redact.js';

const R = REDACTED;
const same = text => assert.equal(redactSecrets(text), text, `should be untouched: ${text}`);

test('vendor token prefixes are redacted', () => {
  // Fake tokens, assembled at runtime so GitHub push protection doesn't take the fixtures for real secrets.
  const secrets = [
    ['sk-ant-', 'api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['sk-proj-', 'abcdefghijklmnop1234'],
    ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github_pat_', '11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz'],
    ['xox', 'b-123456789012-abcdefghijklmnop'],
    ['xapp-', '1-A0123456789-abcdefghij'],
    ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'],
    ['gsk_', 'abcdefghijklmnopqrstuvwx'],
    ['npm_', 'abcdefghijklmnopqrstuvwxyz0123'],
    ['hf_', 'abcdefghijklmnopqrstuv'],
    ['sk_live_', 'abcdefghijklmnop1234'],
    ['AKIA', 'IOSFODNN7EXAMPLE'],
    ['eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ].map(p => p.join(''));
  for (const s of secrets) {
    const out = redactSecrets(`the key is ${s} ok`);
    assert.equal(out, `the key is ${R} ok`, s);
  }
  assert.equal(redactSecrets('use AKIAIOSFODNN7EXAMPLE here'), `use ${R} here`);
});

test('private key blocks are redacted, also when truncated', () => {
  const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcdEFGH\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactSecrets(`before\n${block}\nafter`), `before\n${R}\nafter`);
  assert.equal(redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQyNTUxOQAAACD'), R);
  same('-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----');
});

test('Authorization headers and bearer tokens keep their scheme', () => {
  assert.equal(redactSecrets('curl -H "Authorization: Bearer abcdef1234567890XYZ" https://x.test'), `curl -H "Authorization: Bearer ${R}" https://x.test`);
  assert.equal(redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA=='), `Authorization: Basic ${R}`);
  assert.equal(redactSecrets('{"authorization":"Bearer tok_1234567890abcdef"}'), `{"authorization":"Bearer ${R}"}`);
  assert.equal(redactSecrets('sent Bearer abcdefghijklmnopqrstuvwxyz0123456789 upstream'), `sent Bearer ${R} upstream`);
  same('He was a bearer of bad news and a Bearer token is how you authenticate.');
});

test('passwords in URLs are redacted, hosts and ports are not', () => {
  assert.equal(redactSecrets('postgres://admin:s3cr3tPass@db.internal:5432/app'), `postgres://admin:${R}@db.internal:5432/app`);
  assert.equal(redactSecrets('git clone https://bob:ghs_x@github.com/o/r'), `git clone https://bob:${R}@github.com/o/r`);
  same('https://example.com:8080/path?a=b@c');
  same('git@github.com:org/repo.git');
  same('ssh://git@host:22/repo');
});

test('secret-named assignments are redacted', () => {
  assert.equal(redactSecrets('ANTHROPIC_API_KEY=abc123def456ghi'), `ANTHROPIC_API_KEY=${R}`);
  assert.equal(redactSecrets('export DB_PASSWORD="hunter2hunter2"'), `export DB_PASSWORD="${R}"`);
  assert.equal(redactSecrets('{"apiKey": "abcd1234efgh", "name": "x"}'), `{"apiKey": "${R}", "name": "x"}`);
  assert.equal(redactSecrets('{\\"password\\": \\"hunter22\\"}'), `{\\"password\\": \\"${R}\\"}`);
  assert.equal(redactSecrets('https://api.test/v1?token=abcd1234efgh&x=1'), `https://api.test/v1?token=${R}&x=1`);
  assert.equal(redactSecrets('run --api-key=abcd1234efgh now'), `run --api-key=${R} now`);
  assert.equal(redactSecrets('password: hunter2!'), `password: ${R}`);
});

test('ordinary text is left alone', () => {
  same('The password policy requires 12 characters and a token refresh every hour.');
  same('password: required');
  same('token: none');
  same('monkey: bananas, donkey: carrot, key: value');
  same('Set MAX_RETRIES=5 and TIMEOUT_MS=3000 in the config.');
  same('sk-short');
  same('Please review src/auth/token.ts and the secret santa list.');
  same('const hash = "abcdef0123456789abcdef0123456789abcdef01"; // a git sha, not a key');
  same('see https://example.com/docs#password-reset');
});

test('non-strings pass through and replacements are counted once', () => {
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(42), 42);
  assert.equal(redactSecrets(''), '');
  let n = 0;
  const out = redactSecrets('TOKEN=abcdef123456 and Authorization: Bearer abcdef1234567890 and ghp_abcdefghijklmnopqrstuvwxyz', () => n++);
  assert.equal(out, `TOKEN=${R} and Authorization: Bearer ${R} and ${R}`);
  assert.equal(n, 3);
  assert.equal(redactSecrets(out), out); // idempotent
});

test('a large text without secrets stays fast', () => {
  const text = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20_000);
  const t0 = Date.now();
  assert.equal(redactSecrets(text), text);
  assert.ok(Date.now() - t0 < 2000, 'redaction is linear');
  const noise = 'a1b2'.repeat(100_000);
  const t1 = Date.now();
  redactSecrets(noise);
  assert.ok(Date.now() - t1 < 2000, 'long token-like runs are linear');
});
