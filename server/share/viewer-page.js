// Builds the self-contained share page: viewer.html with the decrypt code and the ciphertext envelope
// inlined. One static HTML file per share, uploaded to the user's own bucket; no server logic anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let template = null;

function load() {
  if (template) return template;
  const html = fs.readFileSync(path.join(dir, 'viewer.html'), 'utf8');
  const decrypt = fs.readFileSync(path.join(dir, 'viewer-decrypt.js'), 'utf8').replace(/^export /gm, '');
  template = html.replace('{{DECRYPT_JS}}', () => decrypt);
  return template;
}

/** @param {object} envelope  validated ciphertext envelope ({v, alg, iv, ct, kdf?}) */
export function buildSharePage(envelope) {
  // Escape "<" so the JSON can't close its <script> element, whatever it contains.
  const json = JSON.stringify(envelope).replace(/</g, '\\u003c');
  return load().replace('{{ENVELOPE_JSON}}', () => json);
}
