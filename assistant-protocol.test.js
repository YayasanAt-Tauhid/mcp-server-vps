import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { normalizeProjectProfile } from './project-profile.js';

const { Server: SSHServer } = ssh2;
const smokeUrl = process.env.MCP_ASSISTANT_SMOKE_URL;

test('MCP protocol exposes project tools and jobs survive ' + (smokeUrl ? 'client reconnection' : 'a complete MCP process restart'), { timeout: 25000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-protocol-'));
  const repo = join(home, 'repo');
  const profiles = join(home, '.mcp-workflow', 'projects');
  mkdirSync(repo);
  mkdirSync(profiles, { recursive: true });
  writeFileSync(join(profiles, 'smoke.json'), JSON.stringify(normalizeProjectProfile({ projectId: 'smoke', repoPath: repo })), { mode: 0o600 });
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const pass = randomBytes(24).toString('hex');
  const peers = new Set();
  const ssh = new SSHServer({ hostKeys: [hostKey] }, peer => {
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('error', () => {});
    peer.on('authentication', context => {
      if (context.method === 'password' && context.username === 'smoke' && context.password === pass) context.accept();
      else context.reject();
    });
    peer.on('ready', () => peer.on('session', accept => {
      accept().on('exec', (acceptExec, _reject, info) => {
        const channel = acceptExec();
        const child = spawn('/bin/sh', ['-c', info.command], { cwd: repo, env: { ...process.env, HOME: home } });
        child.stdout.on('data', chunk => { if (!channel.destroyed) channel.write(chunk); });
        child.stderr.on('data', chunk => { if (!channel.destroyed) channel.stderr.write(chunk); });
        channel.on('error', () => {});
        channel.pipe(child.stdin);
        child.on('close', code => { if (!channel.destroyed) { channel.exit(code ?? 1); channel.end(); } });
      });
    }));
  });
  await new Promise((resolve, reject) => { ssh.once('error', reject); ssh.listen(0, '127.0.0.1', resolve); });
  const port = ssh.address().port;
  const connectionId = 'assistant-smoke-' + randomBytes(6).toString('hex');
  let client;
  async function connect() {
    let transport;
    if (smokeUrl) {
      const url = new URL(smokeUrl);
      assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
      const contents = readFileSync(process.env.MCP_ASSISTANT_AUTH_ENV, 'utf8');
      const bearer = contents.split(/\r?\n/).find(line => line.startsWith('MCP_TOKEN='))?.slice('MCP_TOKEN='.length).trim();
      assert.ok(bearer, 'Static authentication must be configured for HTTP smoke');
      transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + bearer } } });
    } else {
      transport = new StdioClientTransport({ command: process.execPath, args: ['index.js'], cwd: new URL('.', import.meta.url).pathname, stderr: 'pipe', env: { ...process.env, SHARED_BROWSER_ENABLED: 'false' } });
    }
    transport.stderr?.on('data', () => {});
    client = new Client({ name: 'assistant-protocol-test', version: '1.0.0' });
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, '3.11.0');
    const response = await client.callTool({ name: 'ssh_connect', arguments: { connectionId, host: '127.0.0.1', port, username: 'smoke', password: pass } });
    assert.match(response.content[0].text, /Berhasil terhubung/);
  }
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: { connectionId, projectId: 'smoke', ...args } });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  }
  t.after(async () => {
    try { await client?.callTool({ name: 'ssh_disconnect', arguments: { connectionId } }); } catch {}
    await client?.close();
    for (const peer of peers) peer.end();
    await new Promise(resolve => ssh.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  await connect();
  const tools = await client.listTools();
  for (const name of ['ssh_memory', 'ssh_skill', 'ssh_job']) assert.ok(tools.tools.some(tool => tool.name === name));
  assert.equal((await call('ssh_memory', { action: 'save', memoryId: 'runtime', title: 'Runtime', content: 'Protocol verified', expectedRevision: 0 })).entry.revision, 1);
  assert.equal((await call('ssh_memory', { action: 'search', query: 'protocol' })).items[0].memoryId, 'runtime');
  const conflict = await client.callTool({ name: 'ssh_memory', arguments: { connectionId, projectId: 'smoke', action: 'save', memoryId: 'runtime', title: 'Stale', content: 'Must fail', expectedRevision: 0 } });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /REVISION_CONFLICT/);
  await call('ssh_skill', { action: 'save', skillId: 'inspect', title: 'Inspect', content: 'Inspect source before changes.' });
  assert.equal((await call('ssh_skill', { action: 'get', skillId: 'inspect' })).entry.content, 'Inspect source before changes.');
  await call('ssh_job', { action: 'start', jobId: 'restart', command: "sleep 2; printf 'survived-mcp-restart\\n'" });
  await client.callTool({ name: 'ssh_disconnect', arguments: { connectionId } });
  await client.close();
  await connect();
  assert.equal((await call('ssh_memory', { action: 'get', memoryId: 'runtime' })).entry.revision, 1);
  const deadline = Date.now() + 9000;
  let job;
  do {
    job = (await call('ssh_job', { action: 'status', jobId: 'restart' })).job;
    if (job.state === 'succeeded') break;
    assert.ok(['queued', 'running'].includes(job.state), JSON.stringify(job));
    await delay(100);
  } while (Date.now() < deadline);
  assert.equal(job.state, 'succeeded');
  assert.equal(job.exitCode, 0);
  assert.match((await call('ssh_job', { action: 'logs', jobId: 'restart' })).output, /survived-mcp-restart/);
});
