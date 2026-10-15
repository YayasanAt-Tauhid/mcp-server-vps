import assert from 'node:assert/strict';
import {existsSync,readFileSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {chromium} from 'playwright';

if(existsSync('.env'))throw Error('Use an isolated worktree without .env');
const base='http://127.0.0.1:3101', bearer=randomBytes(32).toString('hex');
const dir=mkdtempSync(join(tmpdir(),'safara-browser-test-'));
const child=spawn(process.execPath,['index.js','--http'],{env:{...process.env,PORT:'3101',BIND_HOST:'127.0.0.1',BASE_URL:base,MCP_TOKEN:bearer,APPROVE_PASSWORD:randomBytes(32).toString('hex'),SHARED_BROWSER_ENABLED:'true',UPLOAD_ALLOWED_ROOTS:dir,IMAGE_READ_ALLOWED_ROOTS:dir},stdio:['ignore','ignore','pipe']});
let diagnostics='';child.stderr.on('data',d=>{diagnostics=(diagnostics+d).slice(-4000)});
const fixture=http.createServer((req,res)=>res.end('<!doctype html><title>Safara Browser Test</title><h1>Browser test</h1><label>Name<input id="name"></label><select id="choice"><option value="a">A</option><option value="b">B</option></select><label>Password<input type="password" id="password"></label><button onclick="document.querySelector(\'#result\').textContent=\'Clicked\'">Click fixture</button><p id="result"></p>'));
await new Promise(r=>fixture.listen(3112,'127.0.0.1',r));
const client=new Client({name:'safara-browser-smoke',version:'1.0.0'});
let testTab, browser, connection=false, checks=0;
const pass=label=>{checks++;console.log('PASS '+label)};
const raw=(name,args={})=>client.callTool({name,arguments:args});
async function call(name,args={}){const r=await raw(name,args);const t=r.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'';if(r.isError||/^[^\n]*Error:/.test(t))throw Error(name+': '+t.slice(0,300));try{return JSON.parse(t)}catch{return t}}
async function rejectedWS(cookie,origin){return new Promise((resolve,reject)=>{
 const req=http.request(base+'/browser/websockify',{headers:{Cookie:cookie,Origin:origin,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':randomBytes(16).toString('base64'),'Sec-WebSocket-Version':'13'}});
 req.setTimeout(5000,()=>req.destroy(Error('websocket timeout')));
 req.on('response',res=>{res.resume();resolve(res.statusCode)});
 req.on('upgrade',(_res,socket)=>{socket.destroy();reject(Error('unauthorized websocket accepted'))});
 req.on('error',reject);req.end();
})}
try{
 let ready=false;for(let i=0;i<50;i++){try{if((await fetch(base+'/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,150))}
 assert(ready,'sidecar not ready');
 await client.connect(new StreamableHTTPClientTransport(new URL(base),{requestInit:{headers:{Authorization:'Bearer '+bearer}}}));
 const list=await client.listTools();assert.equal(list.tools.length,40);pass('40 MCP tools');
 const resources=await client.listResources();assert.equal(resources.resources.length,1);
 const content=await client.readResource({uri:resources.resources[0].uri});assert(content.contents[0].text.includes('Browser Safara'));pass('MCP browser card');
 for(const path of ['/browser/view','/browser/vnc.html','/browser/core/rfb.js'])assert.equal((await fetch(base+path)).status,401);
 assert.equal(await rejectedWS('',base),401);pass('viewer assets and websocket require session');
 const view=await raw('browser_view');const link=view._meta.browserViewUrl;assert(link);
 const preview=await fetch(link,{redirect:'manual'});assert.equal(preview.status,200);
 assert.equal((await fetch(link,{redirect:'manual'})).status,200); // preview must not consume
 const login=await fetch(link,{method:'POST',headers:{Origin:base},redirect:'manual'});assert.equal(login.status,303);
 const cookie=login.headers.get('set-cookie').split(';')[0];assert(login.headers.get('set-cookie').includes('HttpOnly'));
 assert.equal((await fetch(link,{method:'POST',headers:{Origin:base},redirect:'manual'})).status,401);
 assert.equal(await rejectedWS(cookie,'https://attacker.invalid'),403);pass('signed login, replay and origin checks');
 const tabs=await call('browser_tabs',{action:'new',url:'http://127.0.0.1:3112'});testTab=tabs.find(t=>t.active).index;
 const snap=await call('browser_snapshot',{tabIndex:testTab});assert(snap.interactive.some(x=>x.type==='password'));
 await call('browser_type',{tabIndex:testTab,selector:'#name',value:'Test user'});
 await call('browser_select',{tabIndex:testTab,selector:'#choice',value:'b'});
 await call('browser_click',{tabIndex:testTab,text:'Click fixture'});
 await call('browser_wait',{tabIndex:testTab,text:'Clicked'});
 assert((await call('browser_snapshot',{tabIndex:testTab})).bodyText.includes('Clicked'));pass('open snapshot click type select and wait');
 const denied=await raw('browser_type',{tabIndex:testTab,selector:'#password',value:'synthetic-test-value'});assert(denied.isError);pass('sensitive field input rejected');
 const shot=await raw('browser_screenshot',{tabIndex:testTab});const image=shot.content.find(c=>c.type==='image');assert(image);pass('browser screenshot');
 const mode=await call('browser_set_mode',{mode:'mobile',tabIndex:testTab});assert.equal(mode.target.width,390);
 await call('browser_set_mode',{mode:'desktop',tabIndex:testTab});pass('mobile and desktop MCP controls');
 assert.equal((await fetch(base+'/browser/mode',{method:'POST',headers:{Cookie:cookie,Origin:'https://attacker.invalid','Content-Type':'application/json'},body:'{"mode":"mobile"}'})).status,403);
 browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:'/opt/safara/playwright-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'});
 const ctx=await browser.newContext({viewport:{width:1366,height:900}});
 const newLink=(await raw('browser_view'))._meta.browserViewUrl;
 const page=await ctx.newPage();await page.goto(newLink);await page.getByRole('button',{name:'Lanjutkan ke browser Safara'}).click();
 try { await page.frameLocator('iframe').locator('html.noVNC_connected').waitFor({timeout:12000}); } catch(err) { console.log('VIEWER',new URL(page.url()).pathname); for(const f of page.frames())console.log('FRAME',new URL(f.url()).pathname,(await f.locator('body').innerText().catch(()=>'' )).slice(0,700)); await page.screenshot({path:'/tmp/safara-shared-browser-review.png'}); console.log('SAFE_BROWSER_DIAGNOSTICS', diagnostics.split('\n').filter(x=>x.includes('[BROWSER]')).join('; ').slice(-500)); throw err; }
 await page.locator('[data-mode=mobile]').click();await page.locator('[data-mode=mobile][aria-pressed=true]').waitFor();
 await page.locator('[data-mode=desktop]').click();await page.locator('[data-mode=desktop][aria-pressed=true]').waitFor();
 await page.waitForTimeout(1800);await page.screenshot({path:'/tmp/safara-shared-browser-review.png'});
 pass('real noVNC connection and desktop/mobile viewer buttons');
 await call('ssh_connect',{connectionId:'shared-browser-test',host:'127.0.0.1',username:'safara',port:22,privateKey:readFileSync('/home/safara/.ssh/mcp_safara','utf8')});connection=true;
 const upload=join(dir,'image.png'),slot=await call('ssh_create_upload_slot',{connectionId:'shared-browser-test',remotePath:upload});
 const token=new URLSearchParams(new URL(slot.uploadUrl).hash.slice(1)).get('token');
 const send=()=>fetch(base+'/upload-file',{method:'POST',headers:{Authorization:'Upload '+token,'Content-Type':'application/octet-stream'},body:Buffer.from(image.data,'base64')});
 assert.deepEqual((await Promise.all([send(),send()])).map(r=>r.status).sort(),[200,401]);pass('concurrent upload replay rejected');
 const overwrite=await call('ssh_create_upload_slot',{connectionId:'shared-browser-test',remotePath:upload});
 const overwriteToken=new URLSearchParams(new URL(overwrite.uploadUrl).hash.slice(1)).get('token');
 assert.equal((await fetch(base+'/upload-file',{method:'POST',headers:{Authorization:'Upload '+overwriteToken,'Content-Type':'application/octet-stream'},body:Buffer.from(image.data,'base64')})).status,409);pass('existing upload not overwritten');
 symlinkSync('/tmp',join(dir,'escape'));
 const escape=await call('ssh_create_upload_slot',{connectionId:'shared-browser-test',remotePath:join(dir,'escape','should-not-exist.png')});
 const escapeToken=new URLSearchParams(new URL(escape.uploadUrl).hash.slice(1)).get('token');
 assert.equal((await fetch(base+'/upload-file',{method:'POST',headers:{Authorization:'Upload '+escapeToken,'Content-Type':'application/octet-stream'},body:Buffer.from(image.data,'base64')})).status,500);pass('upload symlink escape rejected');
 const read=await raw('ssh_read_image',{connectionId:'shared-browser-test',remotePath:upload});assert(read.content.some(c=>c.type==='image'));pass('image reading regression');
 assert.equal((await fetch(base+'/',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);pass('MCP authentication preserved');
 console.log('RESULT '+checks+' integration checks passed');
}finally{
 if(testTab!==undefined)await raw('browser_tabs',{action:'close',index:testTab}).catch(()=>{});
 if(connection)await raw('ssh_disconnect',{connectionId:'shared-browser-test'}).catch(()=>{});
 if(browser)await browser.close().catch(()=>{});
 await client.close().catch(()=>{});child.kill('SIGTERM');fixture.close();rmSync(dir,{recursive:true,force:true});
}
