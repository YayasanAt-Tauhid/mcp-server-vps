import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['index.js'],
  cwd: root,
  stderr: 'pipe'
});
const client = new Client({ name: 'browser-screenshot-view-test', version: '1.0.0' });

try {
  await client.connect(transport);

  const tools = (await client.listTools()).tools;
  const tool = tools.find(item => item.name === 'browser_screenshot_view');
  assert.ok(tool, 'browser_screenshot_view must be registered');
  assert.equal(tool.inputSchema?.properties?.fullPage?.type, 'boolean');
  assert.equal(tool.inputSchema?.properties?.tabIndex?.type, 'number');
  assert.equal(tool._meta?.ui?.resourceUri, 'ui://attauhid/browser-screenshot-v1.html');

  const resources = (await client.listResources()).resources;
  const resource = resources.find(item => item.uri === 'ui://attauhid/browser-screenshot-v1.html');
  assert.ok(resource, 'screenshot UI resource must be listed');

  const read = await client.readResource({ uri: resource.uri });
  const html = read.contents[0]?.text || '';
  assert.match(html, /<img[^>]+id="screenshot"/i);
  assert.match(html, /max-width:\s*1280px/i);
  assert.match(html, /screenshotDataUrl/);

  const viewResult = await client.callTool({
    name: 'browser_screenshot_view',
    arguments: { fullPage: false }
  });
  assert.equal(viewResult.isError, undefined);
  assert.equal(viewResult.structuredContent?.ready, true);
  assert.match(viewResult._meta?.screenshotDataUrl || '', /^data:image\/png;base64,/);
  assert.equal(viewResult._meta?.ui?.resourceUri, 'ui://attauhid/browser-screenshot-v1.html');
  assert.ok(!viewResult.content?.some(item => item.type === 'image'), 'view tool should send the PNG to its UI metadata, not duplicate MCP image content');

  const tabsResult = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  const tabsText = tabsResult.content?.find(item => item.type === 'text')?.text || '{}';
  const tabs = JSON.parse(tabsText);
  assert.ok(Array.isArray(tabs) && tabs.length > 0, 'at least one shared browser tab is required for tabIndex verification');

  const fullPageResult = await client.callTool({
    name: 'browser_screenshot_view',
    arguments: { fullPage: true, tabIndex: 0 }
  });
  assert.equal(fullPageResult.isError, undefined);
  assert.equal(fullPageResult.structuredContent?.ready, true);
  assert.match(fullPageResult._meta?.screenshotDataUrl || '', /^data:image\/png;base64,/);

  const pdfResult = await client.callTool({
    name: 'browser_screenshot_view',
    arguments: { format: 'pdf', tabIndex: 0 }
  });
  assert.equal(pdfResult.isError, undefined);
  assert.equal(pdfResult.structuredContent?.ready, true);
  assert.equal(pdfResult.structuredContent?.format, 'pdf');
  assert.match(pdfResult._meta?.pdfData || '', /^[A-Za-z0-9+/=]+$/);

  const originalResult = await client.callTool({
    name: 'browser_screenshot',
    arguments: { fullPage: false }
  });
  assert.ok(originalResult.content?.some(item => item.type === 'image' && item.mimeType === 'image/png'),
    'existing browser_screenshot behavior must remain intact');

  console.log('PASS browser_screenshot_view tool, UI resource, data URI, and original screenshot compatibility');
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
