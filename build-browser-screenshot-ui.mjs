import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['browser-screenshot-ui-src.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  outfile: 'browser-screenshot-ui-bundle.js',
});

const [shell, bundle] = await Promise.all([
  readFile('browser-screenshot-ui-shell.html', 'utf8'),
  readFile('browser-screenshot-ui-bundle.js', 'utf8'),
]);

if (!shell.includes('/*__BROWSER_SCREENSHOT_UI_BUNDLE__*/')) throw new Error('Bundle placeholder not found');
await writeFile('browser-screenshot-ui.html', shell.replace('/*__BROWSER_SCREENSHOT_UI_BUNDLE__*/', () => bundle));
