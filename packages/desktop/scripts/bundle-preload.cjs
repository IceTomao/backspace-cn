// Sandboxed preloads may require Electron, but not adjacent CommonJS modules.
const path = require('node:path');
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, '../src/preload.ts')],
  outfile: path.join(__dirname, '../dist/preload.js'),
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome138',
  external: ['electron'],
  legalComments: 'inline',
  sourcemap: true,
});
