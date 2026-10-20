import test from 'node:test';
import assert from 'node:assert/strict';
import {registerBrowserResources} from './shared-browser.js';

test('MCP resource list and read expose panel v4 with strict embed domain and no cached session URL',async()=>{
  const handlers=[];
  const origin='https://mcp.safara.biz.id';
  const server={setRequestHandler(_schema,handler){handlers.push(handler);}};
  registerBrowserResources(server,()=>{throw Error('resource must not mint signed links');},origin);
  assert.equal(handlers.length,2);
  const listing=await handlers[0]();
  assert.equal(listing.resources[0].uri,'ui://safara/browser-v4.html');
  assert.deepEqual(listing.resources[0]._meta['openai/ui'].availableDisplayModes,['inline','fullscreen']);
  assert.deepEqual(listing.resources[0]._meta.ui.csp.frameDomains,[origin]);

  const payload=await handlers[1]({params:{uri:'ui://safara/browser-v4.html'}});
  const rendered=payload.contents[0].text;
  assert.ok(rendered.length>1500);
  assert.match(rendered,/<iframe[^>]*id="browser"/);
  assert.ok(rendered.includes(origin));
  assert.ok(!rendered.includes('__BROWSER_ORIGIN__'));
  assert.ok(!rendered.includes('__BROWSER_VIEW_URL__'));
  assert.equal(payload.contents[0].mimeType,'text/html;profile=mcp-app');
  assert.deepEqual(payload.contents[0]._meta['openai/ui'].availableDisplayModes,['inline','fullscreen']);
  const legacy=await handlers[1]({params:{uri:'ui://safara/browser-card-v3.html'}});
  assert.equal(legacy.contents[0].mimeType,'text/html;profile=mcp-app');
  await assert.rejects(()=>handlers[1]({params:{uri:'ui://other/browser-v4.html'}}),/tidak ditemukan/);
});
