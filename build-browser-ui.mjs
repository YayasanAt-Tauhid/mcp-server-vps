import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['browser-ui-src.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  outfile: 'browser-ui-bundle.js',
});

const [shell, bundle] = await Promise.all([
  readFile('browser-ui-shell.html', 'utf8'),
  readFile('browser-ui-bundle.js', 'utf8'),
]);
if (!shell.includes('/*__BROWSER_UI_BUNDLE__*/')) throw new Error('Bundle placeholder not found');
await writeFile('browser-ui.html', shell.replace('/*__BROWSER_UI_BUNDLE__*/', bundle));
