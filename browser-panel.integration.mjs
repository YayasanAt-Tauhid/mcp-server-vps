import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root=dirname(fileURLToPath(import.meta.url));
const temp=await mkdtemp(join(tmpdir(),'attauhid-fullscreen-'));
const component=await readFile(join(root,'browser-ui.html'),'utf8');
const browserOrigin='https://browser-vps.hijrah-attauhid.or.id';
const fakeView=browserOrigin+'/embed/login?nonce='+'a'.repeat(32)+'&expires=9999999999999&sig='+'b'.repeat(64);
let browser,client,transport,checks=0,viewerLoads=0;
function check(label){checks++;console.log('PASS '+label)}
const server=http.createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
  if(req.url==='/component') return res.end(component);
  res.end('<!doctype html><style>html,body{margin:0;background:#111827}iframe{border:0;width:390px;height:600px}</style><iframe id="app" src="/component"></iframe><script>'+
  'const iframe=document.querySelector("#app");'+
  'const query=new URLSearchParams(location.search);'+
  'window.state={requests:[],mode:query.get("initial")||"inline",reject:false,modes:query.has("unsupported")?["inline"]:["inline","fullscreen"],capabilities:null,toolCalls:0};'+
  'function context(){return {displayMode:state.mode,availableDisplayModes:state.modes,platform:"mobile",containerDimensions:{width:390,height:state.mode==="fullscreen"?780:600}}}'+
  'window.notify=(params)=>iframe.contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/host-context-changed",params},"*");'+
  'window.addEventListener("message",e=>{if(e.source!==iframe.contentWindow||e.data.jsonrpc!=="2.0")return;const m=e.data;'+
  'function reply(result){e.source.postMessage({jsonrpc:"2.0",id:m.id,result},e.origin)}'+
  'if(m.method==="ui/initialize"){state.capabilities=m.params.appCapabilities;iframe.style.height=context().containerDimensions.height+"px";reply({protocolVersion:m.params.protocolVersion,hostInfo:{name:"Fullscreen integration host",version:"1.0"},hostCapabilities:{serverTools:{},openLinks:{}},hostContext:context()})}'+
  'else if(m.method==="tools/call"){state.toolCalls++;if(m.params.name==="browser_get_view_url")reply({content:[],structuredContent:{url:'+JSON.stringify(fakeView)+'}});else reply({content:[],structuredContent:{mode:m.params.arguments.mode}})}'+
  'else if(m.method==="ui/request-display-mode"){state.requests.push(m.params.mode);if(state.reject){e.source.postMessage({jsonrpc:"2.0",id:m.id,error:{code:-32603,message:"Mode not available"}},e.origin);return}state.mode=m.params.mode;iframe.style.height=context().containerDimensions.height+"px";reply({mode:state.mode});notify(context())}'+
  'else if(m.method==="ui/notifications/size-changed"){if(state.mode==="inline")iframe.style.height=m.params.height+"px"}'+
  'else if(m.method==="ui/open-link"){state.openLink=m.params.url;reply({})}'+
  'else if("id" in m)reply({});});</script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
try{
  transport=new StdioClientTransport({command:process.execPath,args:['index.js'],cwd:root,stderr:'pipe'});
  client=new Client({name:'fullscreen-resource-test',version:'1.0'});
  await client.connect(transport);
  const resources=await client.listResources();
  const resource=resources.resources.find(r=>r.uri.startsWith('ui://attauhid/browser-card-'));
  assert.ok(resource);
  assert.deepEqual(resource._meta['openai/ui'].availableDisplayModes,['inline','fullscreen']);
  const read=await client.readResource({uri:resource.uri});
  assert.deepEqual(read.contents[0]._meta['openai/ui'].availableDisplayModes,['inline','fullscreen']);
  assert.ok(read.contents[0].text.includes('⛶ Fullscreen'));
  check('MCP resource listing and contents advertise inline and fullscreen');

  browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:'/opt/mcp-attauhid/chromium-1243/chrome-linux64/chrome'});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await context.route(browserOrigin+'/**',route=>{
    viewerLoads++;
    return route.fulfill({contentType:'text/html',body:'<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#14532d;color:white;display:grid;place-items:center;font:24px system-ui}</style><p id="visible">Layar browser aktif</p><script>parent.postMessage({type:"attauhid-browser-state",state:"connected",mode:"desktop"},"*")</script>'});
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);
  let app=page.frames().find(f=>f.url().endsWith('/component'));
  await app.waitForFunction(()=>document.querySelector('#status').textContent==='Terhubung');
  assert.deepEqual(await page.evaluate(()=>state.capabilities.availableDisplayModes),['inline','fullscreen']);
  assert.ok((await app.locator('#browser').boundingBox()).height>400);
  check('actual SDK initialization advertises fullscreen and renders a visible mobile panel');

  const loadsBefore=viewerLoads;
  await app.locator('#mode-fullscreen').click();
  await app.waitForFunction(()=>document.body.classList.contains('fullscreen-mode'));
  assert.equal(await app.locator('#mode-fullscreen').textContent(),'⛶ Kecilkan');
  assert.equal(await app.locator('body').evaluate(el=>el.getBoundingClientRect().height),780);
  assert.ok((await app.locator('#browser').boundingBox()).height>650);
  assert.equal(viewerLoads,loadsBefore);
  assert.equal(await app.locator('#status').textContent(),'Terhubung');
  await page.screenshot({path:join(temp,'fullscreen.png')});
  check('fullscreen fills host height without navigating or losing the existing browser iframe');

  await page.evaluate(()=>{document.querySelector('#app').style.height='480px';notify({containerDimensions:{width:390,height:480}})});
  await app.waitForFunction(()=>document.body.getBoundingClientRect().height===480);
  assert.ok((await app.locator('#browser').boundingBox()).height>300);
  await app.locator('#mode-fullscreen').click();
  await app.waitForFunction(()=>!document.body.classList.contains('fullscreen-mode'));
  assert.equal(await app.locator('#mode-fullscreen').textContent(),'⛶ Fullscreen');
  assert.equal(viewerLoads,loadsBefore);
  check('fullscreen resize and return to inline keep the iframe visible and connected');

  await page.evaluate(()=>{state.reject=true});
  await app.locator('#mode-fullscreen').click();
  await app.waitForFunction(()=>document.querySelector('#status').textContent.includes('gagal dibuka'));
  assert.ok(await app.locator('#external').isVisible());
  assert.ok(await app.locator('#browser').isVisible());
  await app.locator('#external').click();
  await page.waitForFunction(()=>Boolean(state.openLink));
  check('rejected fullscreen keeps the screen visible and provides a fresh-session external fallback');

  await page.goto(origin+'/?initial=fullscreen');
  app=page.frames().find(f=>f.url().endsWith('/component'));
  await app.waitForFunction(()=>document.querySelector('#status').textContent==='Terhubung');
  assert.equal(await app.locator('body').evaluate(el=>el.getBoundingClientRect().height),780);
  assert.ok(await page.evaluate(()=>state.toolCalls>0));
  check('a widget mounted directly in fullscreen restores its browser session without a tool-result replay');

  await page.goto(origin+'/?unsupported=1');
  app=page.frames().find(f=>f.url().endsWith('/component'));
  await app.waitForFunction(()=>document.querySelector('#status').textContent==='Terhubung');
  assert.equal(await app.locator('#mode-fullscreen').isDisabled(),true);
  assert.equal(await app.locator('#external').isVisible(),true);
  assert.deepEqual(errors,[]);
  check('a host without fullscreen support cannot open an unsupported blank presentation');
  console.log(JSON.stringify({checks,screenshot:join(temp,'fullscreen.png'),scope:'MCP host simulation; physical Android app not exercised'}));
}catch(error){
  console.error(error.stack);
  process.exitCode=1;
}finally{
  await browser?.close();
  await client?.close();
  await transport?.close();
  await new Promise(resolve=>server.close(resolve));
}
