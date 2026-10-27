import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { parseKeyscan, writeTarget, removeTarget, updateTarget, testTarget } from './mcp-target-lib.js';
import { fingerprintHostKey, loadTargets } from './ssh-targets.js';
import { startKeySshServer } from './ssh-test-server.js';

const pub = ssh2.utils.generateKeyPairSync('ed25519').public; // "ssh-ed25519 AAAA... "
const [ktype, kb64] = pub.split(' ');
const FP = fingerprintHostKey(Buffer.from(kb64, 'base64'));
const tmp = () => mkdtempSync(join(tmpdir(), 'mcp-target-'));

test('parseKeyscan mengambil fingerprint dari output ssh-keyscan, mengabaikan komentar', () => {
  const out = `# 1.2.3.4:22 SSH-2.0-OpenSSH_9.6\n1.2.3.4 ${ktype} ${kb64}\n[1.2.3.4]:2222 ${ktype} ${kb64}\n\nsampah\n`;
  assert.deepEqual(parseKeyscan(out), [{ type: ktype, fingerprint: FP }]);
  assert.deepEqual(parseKeyscan(''), []);
});

test('writeTarget memvalidasi lalu menulis file dengan izin 0640', () => {
  const dir = tmp();
  try {
    writeTarget(dir, 'gudang', { host: '1.2.3.4', username: 'mcp', hostKeys: [FP] });
    const f = join(dir, 'gudang.json');
    assert.equal(statSync(f).mode & 0o777, 0o640);
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).port, 22);
    assert.ok(loadTargets(dir).targets.has('gudang'));
    assert.throws(() => writeTarget(dir, 'buruk', { host: '1.2.3.4', username: 'mcp', hostKeys: [] }), /hostKeys/);
    assert.ok(!existsSync(join(dir, 'buruk.json')), 'target invalid tidak boleh tertulis');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeTarget menolak menimpa target yang sudah ada kecuali force', () => {
  const dir = tmp();
  try {
    writeTarget(dir, 'a', { host: '1.2.3.4', username: 'mcp', hostKeys: [FP] });
    assert.throws(() => writeTarget(dir, 'a', { host: '5.6.7.8', username: 'mcp', hostKeys: [FP] }), /sudah ada/);
    writeTarget(dir, 'a', { host: '5.6.7.8', username: 'mcp', hostKeys: [FP] }, { force: true });
    assert.equal(loadTargets(dir).targets.get('a').host, '5.6.7.8');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('updateTarget mengubah aturan tanpa menyentuh field lain', () => {
  const dir = tmp();
  try {
    writeTarget(dir, 'a', { host: '1.2.3.4', username: 'mcp', hostKeys: [FP] });
    updateTarget(dir, 'a', { blacklist: ['^rm '], description: 'produksi' });
    const t = loadTargets(dir).targets.get('a');
    assert.deepEqual(t.blacklist, ['^rm ']);
    assert.equal(t.description, 'produksi');
    assert.equal(t.host, '1.2.3.4');
    assert.throws(() => updateTarget(dir, 'tidak-ada', {}), /tidak ditemukan/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('removeTarget menghapus file target', () => {
  const dir = tmp();
  try {
    writeTarget(dir, 'a', { host: '1.2.3.4', username: 'mcp', hostKeys: [FP] });
    removeTarget(dir, 'a');
    assert.equal(loadTargets(dir).targets.size, 0);
    assert.throws(() => removeTarget(dir, 'a'), /tidak ditemukan/);
    assert.throws(() => removeTarget(dir, '../x'), /nama target/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('testTarget konek dengan key + host key pin dan menjalankan whoami', { timeout: 20000 }, async () => {
  const home = tmp();
  const keys = ssh2.utils.generateKeyPairSync('ed25519');
  const keyFile = join(home, 'id');
  writeFileSync(keyFile, keys.private, { mode: 0o600 });
  const ssh = await startKeySshServer({ cwd: home, home, allowedPub: keys.public });
  try {
    writeTarget(home, 'lokal', { host: '127.0.0.1', port: ssh.port, username: 'smoke', hostKeys: [ssh.hostFp] });
    const ok = await testTarget(home, 'lokal', { defaultKeyFile: keyFile, command: 'echo siap' });
    assert.equal(ok.ok, true);
    assert.equal(ok.output, 'siap');
    writeTarget(home, 'palsu', { host: '127.0.0.1', port: ssh.port, username: 'smoke', hostKeys: [FP] });
    const bad = await testTarget(home, 'palsu', { defaultKeyFile: keyFile });
    assert.equal(bad.ok, false);
  } finally { await ssh.close(); rmSync(home, { recursive: true, force: true }); }
});
