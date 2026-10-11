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
const client = new Client({ name: 'browser-extractors-test', version: '1.0.0' });

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find(item => item.type === 'text')?.text || '{}';
  return { result, payload: JSON.parse(text) };
}

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;

  const textTool = tools.find(item => item.name === 'browser_extract_text');
  const transcriptTool = tools.find(item => item.name === 'browser_extract_transcript');
  assert.ok(textTool, 'browser_extract_text must be registered');
  assert.ok(transcriptTool, 'browser_extract_transcript must be registered');
  assert.equal(textTool.inputSchema?.properties?.maxChars?.maximum, 200000);
  assert.equal(transcriptTool.inputSchema?.properties?.maxChars?.maximum, 200000);

  const text = await call('browser_extract_text', {
    tabIndex: 0,
    selector: 'body',
    offset: 0,
    maxChars: 1000
  });
  assert.equal(text.result.isError, undefined);
  assert.equal(text.payload.success, true);
  assert.ok(text.payload.resultLength >= text.payload.returnedLength);

  await client.callTool({
    name: 'browser_execute_js',
    arguments: {
      tabIndex: 0,
      script: `(()=>{const d=document.createElement('div');d.id='mcp-extractor-transcript';d.className='caption';d.innerText='Speaker A: Halo dunia\\nSpeaker B: Tes transcript';document.body.appendChild(d);const l=document.createElement('div');l.id='mcp-extractor-long';l.textContent='X'.repeat(2500);document.body.appendChild(l);return true})()`
    }
  });

  const transcript = await call('browser_extract_transcript', { tabIndex: 0, maxChars: 5000 });
  assert.equal(transcript.result.isError, undefined);
  assert.equal(transcript.payload.success, true);
  assert.equal(transcript.payload.found, true);
  assert.match(transcript.payload.result, /Speaker A: Halo dunia/);
  assert.match(transcript.payload.result, /Speaker B: Tes transcript/);

  const c1 = await call('browser_extract_text', {
    tabIndex: 0, selector: '#mcp-extractor-long', offset: 0, maxChars: 1000
  });
  const c2 = await call('browser_extract_text', {
    tabIndex: 0, selector: '#mcp-extractor-long', offset: c1.payload.nextOffset, maxChars: 1000
  });
  const c3 = await call('browser_extract_text', {
    tabIndex: 0, selector: '#mcp-extractor-long', offset: c2.payload.nextOffset, maxChars: 1000
  });

  assert.equal(c1.payload.resultLength, 2500);
  assert.equal(c1.payload.returnedLength, 1000);
  assert.equal(c1.payload.nextOffset, 1000);
  assert.equal(c2.payload.nextOffset, 2000);
  assert.equal(c3.payload.returnedLength, 500);
  assert.equal(c3.payload.hasMore, false);
  assert.equal(c3.payload.nextOffset, null);

  console.log('PASS browser_extract_text + browser_extract_transcript + pagination');
} finally {
  try {
    await client.callTool({
      name: 'browser_execute_js',
      arguments: {
        tabIndex: 0,
        script: `document.getElementById('mcp-extractor-transcript')?.remove();document.getElementById('mcp-extractor-long')?.remove();true`
      }
    });
  } catch {}
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
