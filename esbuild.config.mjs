import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(__dirname, 'server/index.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: resolve(__dirname, 'server.js'),
  // Native modules and packages that must remain as runtime requires
  external: [
    'ws',
    // Node built-ins (including node:sqlite) are automatically external with platform:node
  ],
  // Preserve dynamic requires (e.g. native module rebuild)
  keepNames: true,
  banner: {
    js: '// ClawChats backend — built by esbuild, source: github.com/clawchatsai/connector\n',
  },
});

console.log('✓ server.js built from server/');
