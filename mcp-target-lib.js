// Operasi registry target untuk CLI admin `mcp-target`.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'ssh2';
import { validateTarget, loadTargets, buildConnectConfig, fingerprintHostKey } from './ssh-targets.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function assertName(name) {
  if (!NAME_RE.test(String(name))) throw new Error(`nama target tidak valid: "${name}"`);
}

// Output `ssh-keyscan` → daftar fingerprint unik per tipe key.
export function parseKeyscan(text) {
  const seen = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || !/^(ssh-|ecdsa-|sk-)/.test(parts[1])) continue;
    const fingerprint = fingerprintHostKey(Buffer.from(parts[2], 'base64'));
    if (!seen.has(fingerprint)) seen.set(fingerprint, { type: parts[1], fingerprint });
  }
  return [...seen.values()];
}

function serialize(t) {
  const out = { host: t.host, port: t.port, username: t.username, hostKeys: t.hostKeys };
  if (t.keyFile) out.keyFile = t.keyFile;
  if (t.whitelist.length) out.whitelist = t.whitelist;
  if (t.blacklist.length) out.blacklist = t.blacklist;
  if (t.description) out.description = t.description;
  return JSON.stringify(out, null, 2) + '\n';
}

export function writeTarget(dir, name, raw, { force = false } = {}) {
  assertName(name);
  const target = validateTarget(raw, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  if (existsSync(file) && !force) throw new Error(`target "${name}" sudah ada (pakai --force untuk menimpa)`);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, serialize(target), { mode: 0o640 });
  renameSync(tmp, file);
  return target;
}

function readRaw(dir, name) {
  assertName(name);
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`target "${name}" tidak ditemukan`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function updateTarget(dir, name, changes) {
  const merged = { ...readRaw(dir, name) };
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) merged[k] = v;
  return writeTarget(dir, name, merged, { force: true });
}

export function removeTarget(dir, name) {
  readRaw(dir, name);
  unlinkSync(join(dir, `${name}.json`));
}

export function testTarget(dir, name, { defaultKeyFile, command = 'whoami', timeoutMs = 15000 } = {}) {
  const target = loadTargets(dir).targets.get(name);
  if (!target) return Promise.resolve({ ok: false, error: `target "${name}" tidak ditemukan atau tidak valid` });
  let config;
  try { config = buildConnectConfig(target, defaultKeyFile ? { defaultKeyFile } : {}); } catch (err) {
    return Promise.resolve({ ok: false, error: err.message });
  }
  return new Promise((resolve) => {
    const conn = new Client();
    const done = (r) => { clearTimeout(timer); conn.end(); resolve(r); };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs);
    conn.on('error', (err) => done({ ok: false, error: err.message }));
    conn.on('ready', () => conn.exec(command, (err, stream) => {
      if (err) return done({ ok: false, error: err.message });
      let out = '';
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', () => {});
      stream.on('close', (code) => done({ ok: code === 0, output: out.trim(), exitCode: code }));
    }));
    conn.connect(config);
  });
}
