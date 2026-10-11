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
const client = new Client({ name: 'browser-execute-js-test', version: '1.0.0' });

try {
  await client.connect(transport);

  const tools = (await client.listTools()).tools;
  const tool = tools.find(item => item.name === 'browser_execute_js');
  assert.ok(tool, 'browser_execute_js must be registered');
  assert.equal(tool.inputSchema?.properties?.script?.type, 'string');
  assert.equal(tool.inputSchema?.properties?.tabIndex?.type, 'number');
  assert.equal(tool.inputSchema?.properties?.timeoutMs?.type, 'number');
  assert.ok(tool.inputSchema?.required?.includes('script'));

  const titleResult = await client.callTool({
    name: 'browser_execute_js',
    arguments: { script: 'document.title', tabIndex: 0, timeoutMs: 10000 }
  });
  assert.equal(titleResult.isError, undefined);
  const titlePayload = JSON.parse(titleResult.content?.find(item => item.type === 'text')?.text || '{}');
  assert.equal(titlePayload.success, true);
  assert.equal(typeof titlePayload.result, 'string');
  assert.equal(titlePayload.truncated, false);

  const bodyResult = await client.callTool({
    name: 'browser_execute_js',
    arguments: { script: 'document.body.innerText', tabIndex: 0, timeoutMs: 10000 }
  });
  assert.equal(bodyResult.isError, undefined);
  const bodyPayload = JSON.parse(bodyResult.content?.find(item => item.type === 'text')?.text || '{}');
  assert.equal(bodyPayload.success, true);
  assert.ok(bodyPayload.resultLength >= bodyPayload.result.length);
  assert.equal(typeof bodyPayload.truncated, 'boolean');

  const timeoutResult = await client.callTool({
    name: 'browser_execute_js',
    arguments: { script: 'new Promise(() => {})', tabIndex: 0, timeoutMs: 1000 }
  });
  assert.equal(timeoutResult.isError, true);
  assert.match(timeoutResult.content?.find(item => item.type === 'text')?.text || '', /JavaScript timeout/);

  const longScript = "'A'.repeat(200000)+'B'.repeat(200000)+'C'.repeat(50000)";
  const chunk1Result = await client.callTool({
    name: 'browser_execute_js',
    arguments: { script: longScript, tabIndex: 0, offset: 0, maxChars: 200000 }
  });
  const chunk1 = JSON.parse(chunk1Result.content?.find(item => item.type === 'text')?.text || '{}');
  assert.equal(chunk1.resultLength, 450000);
  assert.equal(chunk1.returnedLength, 200000);
  assert.equal(chunk1.offset, 0);
  assert.equal(chunk1.nextOffset, 200000);
  assert.equal(chunk1.hasMore, true);

  const chunk2Result = await client.callTool({
    name: 'browser_execute_js',
    arguments: { script: longScript, tabIndex: 0, offset: chunk1.nextOffset, maxChars: 200000 }
  });
  const chunk2 = JSON.parse(chunk2Result.content?.find(item => item.type === 'text')?.text || '{}');
  assert.equal(chunk2.offset, 200000);
  assert.equal(chunk2.nextOffset, 400000);
  assert.equal(chunk2.hasMore, true);

  const chunk3Result = await client.callTool({
    name: 'browser_execute_js',
    arguments: { script: longScript, tabIndex: 0, offset: chunk2.nextOffset, maxChars: 200000 }
  });
  const chunk3 = JSON.parse(chunk3Result.content?.find(item => item.type === 'text')?.text || '{}');
  assert.equal(chunk3.offset, 400000);
  assert.equal(chunk3.returnedLength, 50000);
  assert.equal(chunk3.nextOffset, null);
  assert.equal(chunk3.hasMore, false);

  console.log('PASS browser_execute_js registration, evaluation, pagination, output metadata, and timeout');
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
