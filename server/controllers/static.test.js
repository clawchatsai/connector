import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { handleStatic, resolveStaticPath } from './static.js';

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-static-'));
  const root = path.join(base, 'plugin');
  fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'frontend', 'app.js'), 'ok');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'secret');
  fs.mkdirSync(path.join(base, 'plugin-evil'));
  fs.writeFileSync(path.join(base, 'plugin-evil', 'x.js'), 'sibling');
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'frontend', 'link.js'));
  fs.symlinkSync(base, path.join(root, 'frontend', 'up'));
  return { base, root };
}

function get(url, root) {
  const out = { status: 0, served: false };
  const res = new Writable({ write(_c, _e, cb) { cb(); } });
  res.writeHead = (s) => { out.status = s; out.served = true; };
  out.handled = handleStatic({ url }, res, root);
  return out;
}

test('static files: inside the plugin dir only (.., absolute, NUL, sibling prefix, symlinks)', async () => {
  const { base, root } = setup();
  assert.equal(resolveStaticPath(root, 'frontend/app.js'), fs.realpathSync(path.join(root, 'frontend', 'app.js')));
  for (const rel of ['frontend/../../secret.txt', '../secret.txt', path.join(base, 'secret.txt'), '/etc/passwd',
    'frontend/app.js\0.png', '../plugin-evil/x.js', 'frontend/link.js', 'frontend/up/secret.txt', 'frontend/missing.js', '']) {
    assert.equal(resolveStaticPath(root, rel), null, JSON.stringify(rel));
  }
  assert.equal(resolveStaticPath(root, 42), null);

  assert.equal(get('/frontend/app.js', root).status, 200);
  for (const url of ['/frontend/../../secret.txt', '/frontend/../../../../etc/passwd', '/lib/../../secret.txt',
    '/frontend/link.js', '/frontend/up/secret.txt', '/frontend/app.js%00']) {
    const r = get(url, root);
    assert.equal(r.handled, false, url);
    assert.equal(r.served, false, url);
  }
  await new Promise(r => setTimeout(r, 50)); // the served file's read stream
  fs.rmSync(base, { recursive: true, force: true });
});
