import { generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import ssh2 from 'ssh2';
import { fingerprintHostKey } from './ssh-targets.js';

const { Server: SSHServer, utils } = ssh2;

// SSH server lokal yang hanya menerima public key tertentu.
export async function startKeySshServer({ cwd, home, allowedPub }) {
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const hostFp = fingerprintHostKey(utils.parseKey(hostKey).getPublicSSH());
  const allowed = utils.parseKey(allowedPub);
  const allowedBlob = allowed.getPublicSSH();
  const peers = new Set();
  const server = new SSHServer({ hostKeys: [hostKey] }, (peer) => {
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('error', () => {});
    peer.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey' || ctx.username !== 'smoke') return ctx.reject(['publickey']);
      const same = ctx.key.algo === allowed.type && ctx.key.data.length === allowedBlob.length && timingSafeEqual(ctx.key.data, allowedBlob);
      if (!same) return ctx.reject(['publickey']);
      if (!ctx.signature) return ctx.accept();
      return allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject(['publickey']);
    });
    peer.on('ready', () => peer.on('session', (accept) => {
      accept().on('exec', (acceptExec, _reject, info) => {
        const channel = acceptExec();
        const child = spawn('/bin/sh', ['-c', info.command], { cwd, env: { ...process.env, HOME: home } });
        child.stdout.on('data', (c) => { if (!channel.destroyed) channel.write(c); });
        child.stderr.on('data', (c) => { if (!channel.destroyed) channel.stderr.write(c); });
        channel.on('error', () => {});
        channel.pipe(child.stdin);
        child.on('close', (code) => { if (!channel.destroyed) { channel.exit(code ?? 1); channel.end(); } });
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    hostFp,
    close: async () => { for (const p of peers) p.end(); await new Promise((r) => server.close(r)); }
  };
}

export function writeRegistry(home, targets) {
  const dir = join(home, 'targets.d');
  mkdirSync(dir, { recursive: true });
  for (const [name, t] of Object.entries(targets)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(t));
  return dir;
}
