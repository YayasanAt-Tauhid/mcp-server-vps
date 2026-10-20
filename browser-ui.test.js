import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const origin = 'https://mcp.safara.biz.id';
const source = readFileSync(new URL('./browser-ui-src.js', import.meta.url),'utf8');

async function setup({invalid = false, connectFails = false} = {}) {
  const callbacks = new Map();
  const nodes = Object.fromEntries(['browser','empty','status','retry','desktop','mobile','external'].map(id => [
    id, { disabled: false, hidden: false, textContent: '', src: '',
      addEventListener(type,handler) { callbacks.set(id+':'+type,handler); }
    }
  ]));
  const links = [];
  const calls = [];
  let counter = 0;
  class FakeApp {
    async connect() { if (connectFails) throw Error('unsupported'); }
    async callServerTool({name,arguments: args}) {
      calls.push({name,args});
      if (name === 'browser_get_view_url') {
        ++counter;
        const url = invalid ? 'https://attacker.test/browser/login?nonce=invalid'
          : origin+'/browser/login?nonce='+String(counter).padStart(32,'0')+
          '&expires=1790000000000&sig='+'a'.repeat(64);
        return {structuredContent:{url}};
      }
      return {structuredContent:{mode:args.mode}};
    }
    async openLink({url}) { links.push(url); }
  }
  const window = {};
  if (connectFails) {
    const bridge = new FakeApp();
    window.openai = {callTool:(name,args)=>bridge.callServerTool({name,arguments:args})};
  }
  const js = source.replace(/^import\s+\{ App \} from '@modelcontextprotocol\/ext-apps';\s*/,'')
    .replace('__BROWSER_ORIGIN__', JSON.stringify(origin));
  vm.runInNewContext(js,{ App:FakeApp,URL,document:{getElementById:(id)=>nodes[id]},window,console });
  async function flush() {
    for (let i=0;i<6;i++) await new Promise(resolve=>setImmediate(resolve));
  }
  await flush();
  return {
    nodes,calls,links,
    async click(id) { assert.ok(callbacks.has(id+':click'));await callbacks.get(id+':click')(); await flush(); },
    get issued(){return counter;}
  };
}

test('browser panel requests fresh signed iframe URL from MCP Apps SDK at startup and retry',async()=>{
  const ui=await setup();
  assert.equal(ui.issued,1);
  assert.match(ui.nodes.browser.src,/^https:\/\/mcp\.safara\.biz\.id\/browser\/login\?/);
  assert.equal(ui.nodes.empty.hidden,true);
  await ui.click('retry');
  assert.equal(ui.issued,2);
  assert.notEqual(ui.calls[0].args?.mode,'mobile');
  assert.match(ui.nodes.browser.src,/nonce=0{31}2/);
});

test('Safara panel refuses unsafe session targets and provides visible error',async()=>{
  const ui=await setup({invalid:true});
  assert.equal(ui.nodes.browser.src,'');
  assert.equal(ui.nodes.empty.hidden,false);
  assert.match(ui.nodes.status.textContent,/Gagal terhubung/);
});

test('external view uses host openLink with a newly minted signed session',async()=>{
  const ui=await setup();
  await ui.click('external');
  assert.equal(ui.issued,2);
  assert.equal(ui.links.length,1);
  assert.match(ui.links[0],/nonce=0{31}2/);
});

test('mobile mode invokes existing secured browser_set_mode tool',async()=>{
  const ui=await setup();
  await ui.click('mobile');
  assert.equal(ui.calls.at(-1).name,'browser_set_mode');
  assert.equal(ui.calls.at(-1).args.mode,'mobile');
});

test('older ChatGPT bridge remains a fallback when MCP Apps connection is unavailable',async()=>{
  const ui=await setup({connectFails:true});
  assert.equal(ui.issued,1);
  assert.match(ui.nodes.browser.src,/^https:\/\/mcp\.safara\.biz\.id\/browser\/login/);
});
