import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

test('embedded HTML JS is syntactically valid after applying shell replacement',async()=>{
  const html = readFileSync(new URL('./browser-ui.html', import.meta.url),'utf8');
  const begin = html.indexOf('<script>') + '<script>'.length;
  const end = html.lastIndexOf('</script>');
  assert.ok(begin >= 8 && end > begin);
  const script = html.slice(begin,end).replace('__BROWSER_ORIGIN__',JSON.stringify('https://mcp.safara.biz.id'));
  // Regression: String.replace(search, bundle) interpolates special $&,$$, $' and $\`
  // sequences within minified JS and corrupts the bundle. Use () => bundle.
  await transform(script,{loader:'js'});
  assert.ok(script.includes('Browser Safara'));
});
