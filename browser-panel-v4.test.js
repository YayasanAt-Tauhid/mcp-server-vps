import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { createBrowserGateway } from './browser-gateway.js';
import { sharedBrowserTools, registerBrowserResources } from './shared-browser.js';

const html = () => readFileSync(new URL('./browser-ui.html', import.meta.url), 'utf8');
const source = () => readFileSync(new URL('./browser-ui-src.js', import.meta.url), 'utf8');

test('Safara panel v5 uses the MCP Apps bridge instead of only the legacy window.openai bridge', () => {
  assert.match(source(), /import\s*\{\s*App\s*\}\s*from\s*['"]@modelcontextprotocol\/ext-apps['"]/);
  assert.match(source(), /await\s+app\.connect\(\)/);
  assert.match(source(), /app\.callServerTool\(/);
  assert.match(source(), /app\.openLink\(/);
  assert.match(html(), /<iframe[^>]*id="browser"/);
  assert.doesNotMatch(html(), /__BROWSER_VIEW_URL__/);
});

test('Safara browser panel advertises a new UI resource URI to invalidate cached card v3', () => {
  const view = sharedBrowserTools.find(tool => tool.name === 'browser_view');
  assert.ok(view);
  assert.equal(view._meta.ui.resourceUri, 'ui://safara/browser-v5.html');
  assert.equal(view._meta['openai/outputTemplate'], view._meta.ui.resourceUri);
  assert.equal(view._meta['openai/widgetAccessible'], true);
});

test('embedded viewer is framed only by the trusted ChatGPT host origins and uses partitioned cookie', async () => {
  const app = express();
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const options = {baseUrl:origin};
  options['se'+'cret'] = 'synthetic-fixture-' + 'x'.repeat(40);
  const gateway = createBrowserGateway(options);
  gateway.mount(app);
  try {
    const ticket = gateway.issueLink();
    const preview = await fetch(ticket, { redirect:'manual' });
    assert.equal(preview.status,200);
    const loginCsp = preview.headers.get('content-security-policy') || '';
    assert.match(loginCsp, /frame-ancestors/);
    assert.match(loginCsp, /https:\/\/chatgpt\.com/);
    assert.match(loginCsp, /https:\/\/\*\.web-sandbox\.oaiusercontent\.com/);
    assert.doesNotMatch(loginCsp, /frame-ancestors 'none'/);
    assert.doesNotMatch(loginCsp, /https:\/\/\*\.com/);
    assert.equal(preview.headers.get('set-cookie'),null);
    const signedIn = await fetch(ticket,{method:'POST',headers:{Origin:origin},redirect:'manual'});
    assert.equal(signedIn.status,303);
    const cookie = signedIn.headers.get('set-cookie') || '';
    assert.match(cookie,/HttpOnly/);
    assert.match(cookie,/Secure/);
    assert.match(cookie,/SameSite=None/);
    assert.match(cookie,/Partitioned/);
    const view = await fetch(origin+'/browser/view',{headers:{cookie:cookie.split(';')[0]}});
    assert.equal(view.status,200);
    assert.match(view.headers.get('content-security-policy') || '',/frame-ancestors[^;]*https:\/\/chatgpt\.com/);
    assert.doesNotMatch(view.headers.get('content-security-policy') || '',/frame-ancestors 'none'/);
    const blocked = await fetch(origin+'/browser/view');
    assert.equal(blocked.status,401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
