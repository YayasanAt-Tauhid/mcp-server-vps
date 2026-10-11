import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { claudeAppDomain } from './browser-embed-security.js';

const root = dirname(fileURLToPath(import.meta.url));
const origin = 'http://127.0.0.1:16081';
const temp = await mkdtemp(join(tmpdir(), 'attauhid-browser-ws-'));
const envFile = process.env.BROWSER_EMBED_ENV_FILE || '/home/attauhid/projects/mcp/mcp-server/.env';
const password = (await readFile(envFile, 'utf8')).split('\n').find(x => x.startsWith('APPROVE_PASSWORD='))?.slice(17).trim();
assert.ok(password, 'Configured browser signing key is required');
let childError = '', checks = 0, browser;
function check(label) { checks++; console.log('PASS ' + label); }
function start(cmd, args, options = {}) {
  const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child.stdout.on('data', chunk => { childError += chunk; });
  child.stderr.on('data', chunk => { childError += chunk; });
  return child;
}
const auth = start(process.execPath, ['embed-auth.js'], {
  env: { ...process.env, BROWSER_EMBED_ENV_FILE: envFile, BROWSER_EMBED_AUTH_PORT: '16082', BROWSER_EMBED_ORIGIN: origin, BROWSER_LOGIN_NONCE_FILE: join(temp, 'nonces.json') }
});
let config = await readFile(join(root, 'attauhid-browser.nginx.conf'), 'utf8');
config = config.replaceAll('127.0.0.1:6081', '127.0.0.1:16081')
  .replaceAll('127.0.0.1:6082', '127.0.0.1:16082')
  .replaceAll('/var/log/nginx/attauhid-browser-ws.log', join(temp, 'ws.log'));
await writeFile(join(temp, 'nginx.conf'), 'pid ' + join(temp, 'nginx.pid') + ';\nerror_log ' + join(temp, 'error.log') + ';\nevents {}\nhttp {\n'
  + 'access_log ' + join(temp, 'access.log') + ';\nclient_body_temp_path ' + join(temp, 'body') + ';\nproxy_temp_path ' + join(temp, 'proxy') + ';\n'
  + config + '\n}\n');
const nginx = start('/usr/sbin/nginx', ['-p', temp, '-c', join(temp, 'nginx.conf'), '-g', 'daemon off;']);
async function req(path, options = {}) {
  return fetch(origin + path, { redirect: 'manual', ...options });
}
async function socket(path, expected, { cookie, requestOrigin = origin } = {}) {
  await new Promise((resolve, reject) => {
    const headers = { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), Origin: requestOrigin };
    if (cookie) headers.Cookie = cookie;
    const request = http.request(origin + path, { headers });
    const timeout = setTimeout(() => { request.destroy(); reject(Error('WebSocket timeout')); }, 5000);
    request.once('response', res => {
      clearTimeout(timeout); res.resume();
      try { assert.equal(res.statusCode, expected); resolve(); } catch (error) { reject(error); }
    });
    request.once('upgrade', (res, sock, head) => {
      try { assert.equal(res.statusCode, expected); } catch (error) { clearTimeout(timeout); sock.destroy(); reject(error); return; }
      function banner(chunk) {
        clearTimeout(timeout);
        try { assert.ok(chunk.includes(Buffer.from('RFB ')), 'RFB banner from the live framebuffer'); resolve(); }
        catch (error) { reject(error); }
        finally { sock.destroy(); }
      }
      if (head.length) banner(head);
      else sock.once('data', banner);
      sock.once('error', reject);
    });
    request.once('error', error => { clearTimeout(timeout); reject(error); });
    request.end();
  });
}
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await req('/embed/view')).status === 302) break; } catch {}
    if (i === 49) throw Error('Isolated services did not start');
    await delay(100);
  }
  assert.equal((await req('/embed/view')).status, 302);
  assert.equal((await req('/embed/connection', { method: 'POST', headers: { Origin: origin } })).status, 401);
  await socket('/embed/websockify', 401);
  check('anonymous viewer, ticket endpoint, and WebSocket remain protected');

  const nonce = crypto.randomBytes(16).toString('hex'), expires = Date.now() + 60000;
  const sig = crypto.createHmac('sha256', password).update('browser-view:' + nonce + ':' + expires).digest('hex');
  const login = await req('/embed/login?' + new URLSearchParams({ nonce, expires: String(expires), sig }));
  assert.equal(login.status, 303);
  assert.match(login.headers.get('content-security-policy'), /frame-ancestors.*https:\/\/claude\.ai/);
  assert.equal(login.headers.get('x-frame-options'),null);
  const replay=await req('/embed/login?' + new URLSearchParams({nonce,expires:String(expires),sig}));
  assert.equal(replay.status,200);
  assert.equal(replay.headers.get('set-cookie'),null);
  check('restricted CSP and one-use login prevent a second session from the same URL');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: origin };
  assert.equal((await req('/embed/view', { headers })).status, 200);
  assert.equal((await req('/embed/connection', { headers })).status, 405);
  assert.equal((await req('/embed/connection', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://unrelated.example' } })).status, 403);
  check('signed session loads the viewer; issuance rejects wrong method and origin');

  const ticket = await (await req('/embed/connection', { method: 'POST', headers })).json();
  assert.match(ticket.path, /^embed\/websockify\?ticket=[a-f0-9]{64}$/);
  await socket('/' + ticket.path, 401, { requestOrigin: 'https://unrelated.example' });
  await socket('/' + ticket.path, 101);
  await socket('/' + ticket.path, 401);
  check('cookie-free WebSocket receives a real RFB banner; wrong origin and replay fail');

  await socket('/embed/websockify', 101, { cookie });
  check('existing cookie-authenticated WebSocket compatibility is preserved');

  const invalid = await req('/embed/core/rfb.js?ticket=' + 'f'.repeat(64));
  assert.equal(invalid.status, 302);
  const log = await readFile(join(temp, 'ws.log'), 'utf8');
  assert.ok(!log.includes('ticket='));
  check('tickets do not authorize other resources or appear in WebSocket access logs');

  browser = await chromium.launch({
    headless: true, chromiumSandbox: true,
    executablePath: process.env.BROWSER_SMOKE_EXECUTABLE_PATH || '/opt/mcp-attauhid/chromium-1243/chrome-linux64/chrome'
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'at_browser', value: cookie.slice('at_browser='.length), domain: '127.0.0.1', path: '/embed', httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/embed/view');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Terhubung', null, { timeout: 20000 });
  const vnc = page.frames().find(frame => frame.url().includes('/embed/vnc.html'));
  assert.ok(vnc);
  await vnc.waitForFunction(()=>document.querySelector('#noVNC_container canvas')?.width===390);
  check('mobile viewer receives a portrait framebuffer instead of a scaled desktop');
  await vnc.waitForFunction(() => document.documentElement.classList.contains('noVNC_connected'));
  assert.deepEqual(errors, []);
  check('mobile-sized viewer reaches real noVNC connected state without script errors');

  await vnc.locator('#noVNC_disconnect_button').evaluate(button => button.click());
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Koneksi terputus');
  await page.locator('#retry').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Terhubung');
  check('disconnect status is accurate and reconnect obtains a fresh usable ticket');

  await page.route(origin + '/test-host', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><style>html,body{margin:0;width:100%;height:100%}iframe{width:100%;height:100%;border:0}</style><iframe src="/embed/view"></iframe><script>window.states=[];window.addEventListener("message",e=>{if(e.data?.type==="attauhid-browser-state")states.push(e.data.state)})</script>' }));
  await page.goto(origin + '/test-host');
  await page.waitForFunction(() => window.states.includes('connected'));
  const viewer = page.frames().find(frame => frame.url().endsWith('/embed/view'));
  assert.equal(await viewer.locator('.toolbar').evaluate(el => getComputedStyle(el).display), 'none');
  const embeddedVnc = page.frames().find(frame => frame.url().includes('/embed/vnc.html'));
  await embeddedVnc.waitForFunction(() => {
    const canvas = document.querySelector('#noVNC_container canvas');
    if (!canvas || canvas.width < 100) return false;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4096) colors.add(data[i] + ',' + data[i+1] + ',' + data[i+2]);
    return colors.size > 20;
  }, null, { timeout: 10000 });
  await page.screenshot({ path: join(temp, 'embedded-viewer.png') });
  check('embedded viewer hides duplicate toolbar and reports actual connection state to its parent');
  const violations=[];
  const framedOrigin='https://browser-vps.hijrah-attauhid.or.id';
  await page.route(framedOrigin+'/test-frame', async route=>{
    const response=await req('/embed/login');
    return route.fulfill({status:200,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  page.on('console', message=>{if(message.text().includes('frame-ancestors')) violations.push(message.text())});
  await page.route('https://unrelated.example/**', route=>route.fulfill({contentType:'text/html',body:'<iframe src="'+framedOrigin+'/test-frame"></iframe>'}));
  await page.goto('https://unrelated.example/');
  await page.waitForTimeout(300);
  assert.ok(violations.length>0,'unapproved parent must be blocked by CSP');
  check('unapproved embedding origin is blocked by the browser');
  const claudeSandbox='https://'+claudeAppDomain('https://mcp-vps2.hijrah-attauhid.or.id');
  await page.route('https://claude.ai/**', route=>route.fulfill({contentType:'text/html',body:'<iframe src="'+claudeSandbox+'/app"></iframe>'}));
  await page.route(claudeSandbox+'/**', route=>route.fulfill({contentType:'text/html',body:'<iframe src="'+framedOrigin+'/test-frame"></iframe>'}));
  await page.goto('https://claude.ai/test-host');
  await page.frameLocator('iframe').frameLocator('iframe').locator('input[type=password]').waitFor({state:'visible'});
  check('Claude plus its specific nested MCP sandbox are allowed by frame-ancestors');
  console.log(JSON.stringify({ checks, screenshot: join(temp, 'embedded-viewer.png'), isolatedOrigin: origin }));
} catch (error) {
  console.error(error.name + ': ' + error.message.replace(/ticket=[a-f0-9]+/g, 'ticket=[redacted]'));
  process.exitCode = 1;
} finally {
  await browser?.close();
  nginx.kill('SIGQUIT');
  auth.kill('SIGTERM');
}
