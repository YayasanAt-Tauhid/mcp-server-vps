import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateTarget, loadTargets, fingerprintHostKey, buildConnectConfig,
  stripAclArgs, stripAclFromSchemas, describeTargets
} from './ssh-targets.js';

const blob = Buffer.from('kunci-host-palsu-untuk-test');
const FP = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
const base = { host: '103.67.78.41', port: 2222, username: 'attauhid', hostKeys: [FP] };

function tmp() { return mkdtempSync(join(tmpdir(), 'targets-')); }

test('fingerprint sama dengan format OpenSSH (SHA256 base64 tanpa padding)', () => {
  assert.equal(fingerprintHostKey(blob), FP);
  assert.match(FP, /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test('target valid dinormalisasi dengan default', () => {
  const t = validateTarget({ host: 'vps.example.com', username: 'mcp', hostKeys: [FP] }, 'gudang');
  assert.deepEqual(t, { name: 'gudang', host: 'vps.example.com', port: 22, username: 'mcp', hostKeys: [FP], keyFile: null, whitelist: [], blacklist: [], description: '', uploadRoots: ['/home/mcp', '/tmp'], imageReadRoots: ['/home/mcp', '/tmp'] });
});

test('nama target harus slug', () => {
  assert.throws(() => validateTarget(base, 'Gudang Utama'), /nama target/);
  assert.throws(() => validateTarget(base, '../etc'), /nama target/);
});

test('password ditolak: registry hanya untuk key', () => {
  assert.throws(() => validateTarget({ ...base, password: 'x' }, 'a'), /password/);
});

test('hostKeys wajib dan harus fingerprint SHA256', () => {
  assert.throws(() => validateTarget({ ...base, hostKeys: [] }, 'a'), /hostKeys/);
  assert.throws(() => validateTarget({ ...base, hostKeys: ['MD5:aa'] }, 'a'), /hostKeys/);
});

test('port, host, username, keyFile, regex divalidasi', () => {
  assert.throws(() => validateTarget({ ...base, port: 70000 }, 'a'), /port/);
  assert.throws(() => validateTarget({ ...base, host: 'a b' }, 'a'), /host/);
  assert.throws(() => validateTarget({ ...base, username: 'root;rm' }, 'a'), /username/);
  assert.throws(() => validateTarget({ ...base, keyFile: 'relatif/key' }, 'a'), /keyFile/);
  assert.throws(() => validateTarget({ ...base, blacklist: ['(['] }, 'a'), /blacklist/);
});

test('loadTargets membaca *.json, melaporkan file rusak tanpa menggagalkan yang lain', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'attauhid.json'), JSON.stringify(base));
    writeFileSync(join(dir, 'safara.json'), JSON.stringify({ ...base, host: '103.176.78.52', port: 22, username: 'mcp' }));
    writeFileSync(join(dir, 'rusak.json'), '{bukan json');
    writeFileSync(join(dir, 'catatan.txt'), 'diabaikan');
    const { targets, errors } = loadTargets(dir);
    assert.deepEqual([...targets.keys()].sort(), ['attauhid', 'safara']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].file, 'rusak.json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadTargets pada direktori yang belum ada mengembalikan kosong', () => {
  const { targets, errors } = loadTargets('/tidak/ada/sama/sekali');
  assert.equal(targets.size, 0);
  assert.equal(errors.length, 0);
});

test('buildConnectConfig memakai key default dan memverifikasi host key', () => {
  const dir = tmp();
  try {
    const keyFile = join(dir, 'id_ed25519');
    writeFileSync(keyFile, 'PRIVATE-KEY-DEFAULT');
    const cfg = buildConnectConfig(validateTarget(base, 'attauhid'), { defaultKeyFile: keyFile });
    assert.equal(cfg.host, base.host);
    assert.equal(cfg.port, 2222);
    assert.equal(cfg.username, 'attauhid');
    assert.equal(String(cfg.privateKey), 'PRIVATE-KEY-DEFAULT');
    assert.equal(cfg.password, undefined);
    assert.equal(cfg.hostVerifier(blob), true);
    assert.equal(cfg.hostVerifier(Buffer.from('kunci-penyusup')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildConnectConfig memakai keyFile khusus target bila ada', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'default'), 'DEFAULT');
    writeFileSync(join(dir, 'khusus'), 'KHUSUS');
    const t = validateTarget({ ...base, keyFile: join(dir, 'khusus') }, 'a');
    assert.equal(String(buildConnectConfig(t, { defaultKeyFile: join(dir, 'default') }).privateKey), 'KHUSUS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildConnectConfig memberi error jelas bila key tidak terbaca', () => {
  assert.throws(() => buildConnectConfig(validateTarget(base, 'a'), { defaultKeyFile: '/tidak/ada/key' }), /key SSH/);
});

test('stripAclArgs membuang whitelist/blacklist dari argumen model', () => {
  const input = { connectionId: 'a', command: 'ls', whitelist: ['.*'], blacklist: [] };
  assert.deepEqual(stripAclArgs(input), { connectionId: 'a', command: 'ls' });
  assert.ok('whitelist' in input, 'objek asli tidak boleh dimutasi');
  assert.deepEqual(stripAclArgs(undefined), {});
});

test('stripAclFromSchemas membuang properti whitelist/blacklist dari semua skema', () => {
  const tools = [{ name: 'x', inputSchema: { type: 'object', properties: { a: { type: 'string' }, whitelist: {}, blacklist: {} }, required: ['a', 'blacklist'] } }, { name: 'y' }];
  const out = stripAclFromSchemas(tools);
  assert.deepEqual(Object.keys(out[0].inputSchema.properties), ['a']);
  assert.deepEqual(out[0].inputSchema.required, ['a']);
  assert.ok('whitelist' in tools[0].inputSchema.properties, 'skema asli tidak boleh dimutasi');
  assert.deepEqual(out[1], { name: 'y' });
});

test('describeTargets meringkas target untuk model tanpa membocorkan path key', () => {
  const m = new Map([['safara', validateTarget({ ...base, keyFile: '/etc/mcp-vps/keys/rahasia', description: 'produksi Safara' }, 'safara')]]);
  const s = describeTargets(m);
  assert.match(s, /safara/);
  assert.match(s, /produksi Safara/);
  assert.doesNotMatch(s, /rahasia/);
  assert.equal(describeTargets(new Map()), '(belum ada target terdaftar)');
});

test('root path default mengikuti home user target (root → /root)', () => {
  assert.deepEqual(validateTarget({ ...base, username: 'root' }, 'a').uploadRoots, ['/root', '/tmp']);
});

test('uploadRoots/imageReadRoots bisa diatur dan harus path absolut', () => {
  const t = validateTarget({ ...base, uploadRoots: ['/srv/app/public'], imageReadRoots: ['/srv/app'] }, 'a');
  assert.deepEqual(t.uploadRoots, ['/srv/app/public']);
  assert.deepEqual(t.imageReadRoots, ['/srv/app']);
  assert.throws(() => validateTarget({ ...base, uploadRoots: ['relatif'] }, 'a'), /uploadRoots/);
  assert.throws(() => validateTarget({ ...base, imageReadRoots: '/srv' }, 'a'), /imageReadRoots/);
});

test('buildConnectConfig membawa root path target', () => {
  const dir = tmp();
  try {
    const keyFile = join(dir, 'k'); writeFileSync(keyFile, 'K');
    const cfg = buildConnectConfig(validateTarget(base, 'attauhid'), { defaultKeyFile: keyFile });
    assert.deepEqual(cfg.uploadRoots, ['/home/attauhid', '/tmp']);
    assert.deepEqual(cfg.imageReadRoots, ['/home/attauhid', '/tmp']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
