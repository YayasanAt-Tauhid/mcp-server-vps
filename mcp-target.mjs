#!/usr/bin/env node
// CLI admin registry target SSH untuk server MCP.
//   sudo mcp-target init
//   sudo mcp-target pubkey
//   sudo mcp-target add <nama> --host H [--port 22] --user U [--key /path] [--description "..."] [--yes] [--force]
//   sudo mcp-target list
//   sudo mcp-target test <nama>
//   sudo mcp-target set <nama> [--blacklist REGEX ...] [--whitelist REGEX ...] [--upload-root PATH ...] [--image-root PATH ...] [--description "..."] [--clear-acl]
//   sudo mcp-target remove <nama>
import { execFileSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { hostname } from 'node:os';
import { TARGETS_DIR, DEFAULT_KEY_FILE, loadTargets, describeTargets } from './ssh-targets.js';
import { parseKeyscan, writeTarget, updateTarget, removeTarget, testTarget } from './mcp-target-lib.js';

const GROUP = process.env.MCP_GROUP || 'mcpvps';

function parseArgs(argv) {
  const pos = [];
  const opts = { blacklist: [], whitelist: [], 'upload-root': [], 'image-root': [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (['yes', 'force', 'clear-acl'].includes(key)) { opts[key] = true; continue; }
    const val = argv[++i];
    if (val === undefined) throw new Error(`--${key} butuh nilai`);
    if (Array.isArray(opts[key])) opts[key].push(val);
    else opts[key] = val;
  }
  return { pos, opts };
}

function groupId() {
  try { return Number(execFileSync('getent', ['group', GROUP], { encoding: 'utf8' }).split(':')[2]); } catch { return null; }
}

// Root membuat file milik root:mcpvps agar service bisa membaca tapi tidak mengubah.
function secure(path, mode) {
  chmodSync(path, mode);
  if (process.getuid?.() !== 0) return;
  const gid = groupId();
  if (gid !== null) chownSync(path, 0, gid);
}

function ensureDirs() {
  for (const d of [dirname(TARGETS_DIR), TARGETS_DIR, dirname(DEFAULT_KEY_FILE)]) {
    mkdirSync(d, { recursive: true });
    secure(d, 0o750);
  }
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'ya';
}

const commands = {
  async init() {
    ensureDirs();
    if (!existsSync(DEFAULT_KEY_FILE)) {
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `mcp-server@${hostname()}`, '-f', DEFAULT_KEY_FILE], { stdio: 'ignore' });
      console.log(`Key baru dibuat: ${DEFAULT_KEY_FILE}`);
    } else {
      console.log(`Key sudah ada: ${DEFAULT_KEY_FILE}`);
    }
    secure(DEFAULT_KEY_FILE, 0o640);
    secure(DEFAULT_KEY_FILE + '.pub', 0o644);
    console.log(`Registry: ${TARGETS_DIR}\n\nPublic key (tempel ke ~/.ssh/authorized_keys di setiap VPS target):`);
    console.log(readFileSync(DEFAULT_KEY_FILE + '.pub', 'utf8').trim());
  },

  async pubkey() {
    console.log(readFileSync(DEFAULT_KEY_FILE + '.pub', 'utf8').trim());
  },

  async add({ pos: [name], opts }) {
    if (!name || !opts.host || !opts.user) throw new Error('pakai: mcp-target add <nama> --host H --user U [--port 22]');
    const port = opts.port ? Number(opts.port) : 22;
    ensureDirs();
    console.log(`Mengambil host key ${opts.host}:${port} ...`);
    let scan = '';
    try { scan = execFileSync('ssh-keyscan', ['-p', String(port), '-T', '10', opts.host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (err) { scan = err.stdout || ''; }
    const keys = parseKeyscan(scan);
    if (!keys.length) throw new Error('tidak ada host key yang didapat; cek host/port dan firewall');
    console.log('Host key yang akan dipin:');
    for (const k of keys) console.log(`  ${k.type.padEnd(22)} ${k.fingerprint}`);
    console.log('Bandingkan dengan output di VPS target: for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done');
    if (!opts.yes && !(await confirm('Fingerprint cocok? [y/N] '))) { console.log('Dibatalkan.'); return; }
    const raw = { host: opts.host, port, username: opts.user, hostKeys: keys.map((k) => k.fingerprint) };
    if (opts.key) raw.keyFile = opts.key;
    if (opts.description) raw.description = opts.description;
    writeTarget(TARGETS_DIR, name, raw, { force: !!opts.force });
    secure(join(TARGETS_DIR, `${name}.json`), 0o640);
    const r = await testTarget(TARGETS_DIR, name);
    if (r.ok) console.log(`Target "${name}" tersimpan dan terhubung (whoami: ${r.output}).`);
    else console.log(`Target "${name}" tersimpan, tapi tes koneksi gagal: ${r.error || 'exit ' + r.exitCode}\nPastikan public key (mcp-target pubkey) sudah ada di authorized_keys user ${opts.user}.`);
  },

  async list() {
    const { targets, errors } = loadTargets(TARGETS_DIR);
    console.log(describeTargets(targets));
    for (const e of errors) console.log(`! ${e.file}: ${e.error}`);
  },

  async test({ pos: [name] }) {
    const names = name ? [name] : [...loadTargets(TARGETS_DIR).targets.keys()];
    let allOk = true;
    for (const n of names) {
      const r = await testTarget(TARGETS_DIR, n);
      allOk &&= r.ok;
      console.log(`${r.ok ? 'OK  ' : 'GAGAL'} ${n}${r.ok ? ` (whoami: ${r.output})` : `: ${r.error || 'exit ' + r.exitCode}`}`);
    }
    if (!allOk) process.exitCode = 1;
  },

  async set({ pos: [name], opts }) {
    if (!name) throw new Error('pakai: mcp-target set <nama> [--blacklist R] [--whitelist R] [--description D] [--clear-acl]');
    const changes = { description: opts.description };
    if (opts['clear-acl']) { changes.whitelist = []; changes.blacklist = []; }
    if (opts.blacklist.length) changes.blacklist = opts.blacklist;
    if (opts.whitelist.length) changes.whitelist = opts.whitelist;
    if (opts['upload-root'].length) changes.uploadRoots = opts['upload-root'];
    if (opts['image-root'].length) changes.imageReadRoots = opts['image-root'];
    updateTarget(TARGETS_DIR, name, changes);
    secure(join(TARGETS_DIR, `${name}.json`), 0o640);
    console.log(`Target "${name}" diperbarui.`);
  },

  async remove({ pos: [name], opts }) {
    if (!name) throw new Error('pakai: mcp-target remove <nama>');
    if (!opts.yes && !(await confirm(`Hapus target "${name}"? [y/N] `))) { console.log('Dibatalkan.'); return; }
    removeTarget(TARGETS_DIR, name);
    console.log(`Target "${name}" dihapus. Koneksi yang sedang aktif tetap hidup sampai diputus.`);
  }
};

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!commands[cmd]) {
    console.log('Perintah: init | pubkey | add | list | test | set | remove');
    process.exitCode = cmd ? 1 : 0;
  } else {
    await commands[cmd](parseArgs(rest));
  }
} catch (err) {
  console.error('Error:', err.message);
  process.exitCode = 1;
}
