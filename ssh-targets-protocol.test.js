import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startKeySshServer, writeRegistry } from './ssh-test-server.js';

const { utils } = ssh2;

test('ssh_connect hanya memakai target terdaftar, dengan key dan host key yang dipin', { timeout: 30000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-targets-'));
  const clientKeys = utils.generateKeyPairSync('ed25519');
  const keyFile = join(home, 'id_ed25519');
  writeFileSync(keyFile, clientKeys.private, { mode: 0o600 });
  const ssh = await startKeySshServer({ cwd: home, home, allowedPub: clientKeys.public });
  const targetsDir = writeRegistry(home, {
    lokal: { host: '127.0.0.1', port: ssh.port, username: 'smoke', hostKeys: [ssh.hostFp], description: 'server test', blacklist: ['^rm '] },
    palsu: { host: '127.0.0.1', port: ssh.port, username: 'smoke', hostKeys: ['SHA256:' + 'A'.repeat(43)] }
  });

  const transport = new StdioClientTransport({
    command: process.execPath, args: ['index.js'], cwd: new URL('.', import.meta.url).pathname, stderr: 'pipe',
    env: { ...process.env, SHARED_BROWSER_ENABLED: 'false', MCP_TARGETS_DIR: targetsDir, MCP_SSH_KEY_FILE: keyFile }
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'targets-protocol-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    try { await client.callTool({ name: 'ssh_disconnect', arguments: { connectionId: 'lokal' } }); } catch {}
    await client.close();
    await ssh.close();
    rmSync(home, { recursive: true, force: true });
  });

  const { tools } = await client.listTools();
  for (const tool of tools) {
    const props = Object.keys(tool.inputSchema?.properties || {});
    assert.ok(!props.includes('whitelist') && !props.includes('blacklist'), `${tool.name} masih punya whitelist/blacklist`);
  }
  const connectTool = tools.find((x) => x.name === 'ssh_connect');
  assert.deepEqual(Object.keys(connectTool.inputSchema.properties).sort(), ['connectionId', 'target']);
  assert.deepEqual(connectTool.inputSchema.required, ['target']);
  assert.match(connectTool.description, /lokal: smoke@127\.0\.0\.1/);
  assert.match(connectTool.description, /server test/);

  const unknown = await client.callTool({ name: 'ssh_connect', arguments: { target: 'tidak-ada' } });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /tidak terdaftar[\s\S]*lokal/);

  const legacy = await client.callTool({ name: 'ssh_connect', arguments: { connectionId: 'x', host: '127.0.0.1', port: ssh.port, username: 'smoke', password: 'apa saja' } });
  assert.equal(legacy.isError, true, 'koneksi ad-hoc dengan host/password harus ditolak');

  const mitm = await client.callTool({ name: 'ssh_connect', arguments: { target: 'palsu' } });
  assert.equal(mitm.isError, true, 'host key yang tidak cocok harus ditolak');

  const ok = await client.callTool({ name: 'ssh_connect', arguments: { target: 'lokal' } });
  assert.notEqual(ok.isError, true, ok.content[0].text);
  assert.match(ok.content[0].text, /Berhasil terhubung ke smoke@127\.0\.0\.1.*\(ID: lokal\)/);

  const run = await client.callTool({ name: 'ssh_exec', arguments: { connectionId: 'lokal', command: 'printf halo; echo err >&2; exit 4' } });
  assert.match(run.content[0].text, /halo\n\[stderr\]\nerr\n\[exit code: 4\]/);

  const blocked = await client.callTool({ name: 'ssh_exec', arguments: { connectionId: 'lokal', command: 'rm -rf /tmp/x', blacklist: [], whitelist: ['.*'] } });
  assert.match(blocked.content[0].text, /blacklist/, 'blacklist target tidak boleh bisa di-override model');

  const list = await client.callTool({ name: 'ssh_list_connections', arguments: {} });
  assert.match(list.content[0].text, /lokal/);
  assert.match(list.content[0].text, /Target terdaftar/);
});
