import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safeBrowserViewUrl, extractBrowserViewUrl } from './browser-session-compat.js';
import { sharedBrowserTools } from './shared-browser.js';

const ORIGIN = 'https://mcp.safara.biz.id';
const expires = String(Date.now() + 300000);
const URL_OK = ORIGIN+'/browser/login?nonce='+'a'.repeat(32)+'&expires='+expires+'&sig='+'b'.repeat(64);
const source = () => readFileSync(new URL('./browser-ui-src.js', import.meta.url),'utf8');

test('panel accepts a valid, same-origin, unexpired one-time browser URL',()=>{
  assert.equal(safeBrowserViewUrl(URL_OK,ORIGIN),URL_OK);
});
test('panel rejects foreign origin, mismatched path, malformed signature, expired link and URL credentials',()=>{
  for(const value of [
    URL_OK.replace(ORIGIN,'https://example.com'),
    URL_OK.replace('/browser/login','/browser/view'),
    URL_OK.replace('b'.repeat(64),'bad'),
    URL_OK.replace(expires, String(Date.now()-60000)),
    URL_OK.replace('https://','https://u:p@'),
    URL_OK.replace('nonce=','nonce=bad&nonce=')
  ]) assert.equal(safeBrowserViewUrl(value,ORIGIN),null);
});
test('fallback extracts tickets from host response metadata and tool output, never arbitrary URL',()=>{
  assert.equal(extractBrowserViewUrl({toolResponseMetadata:{browserViewUrl:URL_OK}},ORIGIN),URL_OK);
  assert.equal(extractBrowserViewUrl({toolOutput:{result:{_meta:{browserViewUrl:URL_OK}}}},ORIGIN),URL_OK);
  assert.equal(extractBrowserViewUrl({result:{structuredContent:{url:URL_OK}}},ORIGIN),URL_OK);
  assert.equal(extractBrowserViewUrl({toolResponseMetadata:{browserViewUrl:'https://evil.example/login'}},ORIGIN),null);
  assert.equal(extractBrowserViewUrl({toolResponseMetadata:{browserViewUrl:URL_OK.replace(expires,String(Date.now()-1000))}},ORIGIN),null);
});
test('Safara panel uses MCP Apps result notification and OpenAI compatibility metadata as fallback before tool calls',()=>{
  assert.match(source(),/app\.ontoolresult\s*=/);
  assert.match(source(),/toolResponseMetadata/);
  assert.match(source(),/toolOutput/);
  assert.match(source(),/extractBrowserViewUrl/);
  assert.match(source(),/await\s+app\.connect\(\)/);
  assert.match(source(),/browser_get_view_url/);
  const tool = sharedBrowserTools.find(x=>x.name==='browser_view');
  assert.equal(tool._meta.ui.resourceUri,'ui://safara/browser-v5.html');
});
