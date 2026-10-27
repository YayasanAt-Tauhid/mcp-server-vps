import test from 'node:test';
import assert from 'node:assert/strict';
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Port 9 (discard) agar test tidak pernah menyentuh browser produksi di 9222.
process.env.BROWSER_CDP_URL = 'http://127.0.0.1:9';
const { sharedBrowserTools, registerBrowserResources, handleBrowserTool } = await import('./shared-browser.js');

const PORTED = ['browser_extract_text', 'browser_extract_transcript', 'browser_screenshot_view', 'browser_execute_js'];
const SCREENSHOT_URI = 'ui://attauhid/browser-screenshot-v1.html';

function fakeServer() {
  const handlers = new Map();
  return { handlers, setRequestHandler: (schema, fn) => handlers.set(schema, fn) };
}

test('tool browser dari jalur attauhid tersedia di sharedBrowserTools', () => {
  const names = sharedBrowserTools.map((t) => t.name);
  for (const n of PORTED) assert.ok(names.includes(n), `${n} hilang`);
  assert.equal(new Set(names).size, names.length, 'nama tool duplikat');
});

test('browser_execute_js mewajibkan script', () => {
  const t = sharedBrowserTools.find((x) => x.name === 'browser_execute_js');
  assert.deepEqual(t.inputSchema.required, ['script']);
});

test('browser_screenshot_view menunjuk ke resource UI screenshot', () => {
  const t = sharedBrowserTools.find((x) => x.name === 'browser_screenshot_view');
  assert.equal(t._meta.ui.resourceUri, SCREENSHOT_URI);
});

test('resource UI screenshot terdaftar dan bisa dibaca', async () => {
  const s = fakeServer();
  registerBrowserResources(s, () => 'https://browser.example.test/v?expires=1', 'https://browser.example.test');
  const list = await s.handlers.get(ListResourcesRequestSchema)({ params: {} });
  const uris = list.resources.map((r) => r.uri);
  assert.ok(uris.includes(SCREENSHOT_URI), 'screenshot UI tidak terdaftar');
  assert.ok(uris.some((u) => u.startsWith('ui://safara/browser')), 'panel browser lama hilang');
  const read = await s.handlers.get(ReadResourceRequestSchema)({ params: { uri: SCREENSHOT_URI } });
  assert.match(read.contents[0].text, /<html|<!doctype/i);
  assert.equal(read.contents[0].mimeType, 'text/html;profile=mcp-app');
});

test('panel browser lama tetap bisa dibaca setelah port', async () => {
  const s = fakeServer();
  registerBrowserResources(s, () => 'x', 'https://browser.example.test');
  const read = await s.handlers.get(ReadResourceRequestSchema)({ params: { uri: 'ui://safara/browser-v5.html' } });
  assert.match(read.contents[0].text, /browser\.example\.test/);
});

test('resource tak dikenal tetap ditolak', async () => {
  const s = fakeServer();
  registerBrowserResources(s, () => 'x', 'https://browser.example.test');
  await assert.rejects(() => s.handlers.get(ReadResourceRequestSchema)({ params: { uri: 'ui://lain/x.html' } }));
});

test('handler tool porting dikenali (error browser, bukan null)', async () => {
  for (const n of ['browser_extract_text', 'browser_extract_transcript', 'browser_execute_js']) {
    const args = n === 'browser_execute_js' ? { script: '1+1' } : {};
    const r = await handleBrowserTool(n, args, () => 'x');
    assert.ok(r, `${n} tidak ditangani`);
    assert.equal(r.isError, true);
  }
});
