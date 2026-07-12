import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { Client } from 'ssh2';
import SftpClient from 'ssh2-sftp-client';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const envFile = readFileSync(resolve(__dirname, '.env'), 'utf-8');
  envFile.split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
} catch {}

const MCP_TOKEN = process.env.MCP_TOKEN || '';
const APPROVE_PASSWORD = process.env.APPROVE_PASSWORD || '';
const BASE_URL = process.env.BASE_URL || 'https://mcp-vps2.hijrah-attauhid.or.id';

// SSH connection pool
const sshConnections = new Map();
const sshConfigs = new Map(); // simpan config untuk SFTP reuse
const sshShells = new Map(); // connectionId -> { stream, buffer } (shell persisten)
const sshBackgroundJobs = new Map(); // connectionId -> Set of { pid, logFile, command }

function shQuote(str) {
  return "'" + String(str).replace(/'/g, `'"'"'`) + "'";
}

function checkAcl(command, whitelist, blacklist) {
  if (whitelist && whitelist.length > 0) {
    const allowed = whitelist.some(pattern => new RegExp(pattern).test(command));
    if (!allowed) throw new Error('Perintah ditolak: tidak ada dalam whitelist');
  }
  if (blacklist && blacklist.length > 0) {
    const blocked = blacklist.some(pattern => new RegExp(pattern).test(command));
    if (blocked) throw new Error('Perintah ditolak: ada dalam blacklist');
  }
}

function sshConnect(connectionId, config) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      sshConnections.set(connectionId, conn);
      sshConfigs.set(connectionId, config);
      resolve({ success: true, connectionId });
    });
    conn.on('error', (err) => reject(err));
    conn.connect(config);
  });
}

function sshExec(connectionId, command, whitelist, blacklist) {
  try { checkAcl(command, whitelist, blacklist); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    const conn = sshConnections.get(connectionId);
    if (!conn) return reject(new Error('Koneksi tidak ditemukan: ' + connectionId));
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', d => stdout += d);
      stream.stderr.on('data', d => stderr += d);
      stream.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
    });
  });
}

function sshListFiles(connectionId, remotePath) {
  return new Promise((resolve, reject) => {
    const conn = sshConnections.get(connectionId);
    if (!conn) return reject(new Error('Koneksi tidak ditemukan: ' + connectionId));
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);
        const files = list.map(f => ({
          filename: f.filename,
          isDirectory: f.attrs.isDirectory(),
          size: f.attrs.size,
          lastModified: new Date(f.attrs.mtime * 1000).toISOString()
        }));
        resolve(files);
      });
    });
  });
}

// --- Shell persisten (state cwd/env/venv tersambung antar panggilan) ---

function getOrCreateShell(connectionId) {
  const existing = sshShells.get(connectionId);
  if (existing) return Promise.resolve(existing);
  const conn = sshConnections.get(connectionId);
  if (!conn) return Promise.reject(new Error('Koneksi tidak ditemukan: ' + connectionId));
  return new Promise((resolve, reject) => {
    conn.shell((err, stream) => {
      if (err) return reject(err);
      const shellState = { stream, buffer: '' };
      stream.on('data', (d) => { shellState.buffer += d.toString(); });
      stream.on('close', () => { sshShells.delete(connectionId); });
      sshShells.set(connectionId, shellState);
      resolve(shellState);
    });
  });
}

function sshExecPersistent(connectionId, command, whitelist, blacklist, timeoutMs) {
  try { checkAcl(command, whitelist, blacklist); } catch (e) { return Promise.reject(e); }
  return getOrCreateShell(connectionId).then(shellState => new Promise((resolve, reject) => {
    const marker = 'MCPDONE_' + crypto.randomBytes(8).toString('hex');
    const startLen = shellState.buffer.length;
    let poll;
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error('Timeout menunggu output perintah (shell persisten)'));
    }, timeoutMs || 30000);
    const donePattern = new RegExp(marker + ':(\\d+)');
    poll = setInterval(() => {
      // Cari pola "marker:<digit>" secara langsung, bukan cuma teks marker mentah.
      // Marker mentah juga muncul lebih dulu di echo terminal dari baris perintah
      // `echo "marker:$?"` yang baru diketik (belum dieksekusi, $? masih literal) —
      // kalau berhenti di situ, exit code tidak pernah ketemu (selalu null) dan
      // shell akan menunggu perintah berikutnya sebagai lanjutan baris tsb.
      const searchStr = shellState.buffer.slice(startLen);
      const exitMatch = searchStr.match(donePattern);
      if (!exitMatch) return;
      clearInterval(poll);
      clearTimeout(timeout);
      const idx = startLen + exitMatch.index;
      const before = shellState.buffer.slice(startLen, idx);
      const exitCode = parseInt(exitMatch[1], 10);
      const lines = before.split('\n').filter(l => !l.includes(marker));
      // baris pertama biasanya echo dari command yang diketik
      if (lines.length && lines[0].trim().endsWith(command.trim().split('\n').pop().trim())) lines.shift();
      const output = lines.join('\n').replace(/\r/g, '').trim();
      resolve({ output, exitCode });
    }, 100);
    shellState.stream.write(command + '\n');
    shellState.stream.write(`echo "${marker}:$?"\n`);
  }));
}

function sshCloseShell(connectionId) {
  const shellState = sshShells.get(connectionId);
  if (shellState) {
    shellState.stream.end();
    sshShells.delete(connectionId);
  }
}

// --- Edit file in-place (tanpa download/upload) ---

function sshEditFile(connectionId, remotePath, oldString, newString, replaceAll, whitelist, blacklist) {
  try { checkAcl(`EDIT_FILE ${remotePath}`, whitelist, blacklist); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    const conn = sshConnections.get(connectionId);
    if (!conn) return reject(new Error('Koneksi tidak ditemukan: ' + connectionId));
    const payloadB64 = Buffer.from(JSON.stringify({ path: remotePath, oldString, newString, replaceAll: !!replaceAll })).toString('base64');
    const script = `import json, base64, sys
data = json.loads(base64.b64decode('${payloadB64}').decode('utf-8'))
path, old, new_str, replace_all = data['path'], data['oldString'], data['newString'], data['replaceAll']
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
count = content.count(old)
if count == 0:
    print('ERROR: string tidak ditemukan di file', file=sys.stderr); sys.exit(1)
if count > 1 and not replace_all:
    print('ERROR: string ditemukan %d kali, gunakan replaceAll=true atau perjelas string' % count, file=sys.stderr); sys.exit(1)
new_content = content.replace(old, new_str, -1 if replace_all else 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(new_content)
print('OK: %d penggantian di %s' % (count if replace_all else 1, path))
`;
    conn.exec('python3 -', (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', d => stdout += d);
      stream.stderr.on('data', d => stderr += d);
      stream.on('close', (code) => {
        if (code !== 0) return reject(new Error(stderr.trim() || stdout.trim() || 'Edit gagal'));
        resolve(stdout.trim());
      });
      stream.end(script);
    });
  });
}

// --- Proses background (nohup + log file, dicek/kill via PID) ---

function sshExecBackground(connectionId, command, whitelist, blacklist) {
  try { checkAcl(command, whitelist, blacklist); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    const conn = sshConnections.get(connectionId);
    if (!conn) return reject(new Error('Koneksi tidak ditemukan: ' + connectionId));
    const logFile = `/tmp/mcp_bg_${crypto.randomBytes(6).toString('hex')}.log`;
    const wrapped = `nohup sh -c ${shQuote(command)} > ${logFile} 2>&1 < /dev/null & echo $!`;
    conn.exec(wrapped, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', d => stdout += d);
      stream.stderr.on('data', d => stderr += d);
      stream.on('close', () => {
        const pid = stdout.trim().split('\n').pop().trim();
        if (!pid || isNaN(parseInt(pid, 10))) return reject(new Error('Gagal mendapatkan PID: ' + (stderr || stdout)));
        if (!sshBackgroundJobs.has(connectionId)) sshBackgroundJobs.set(connectionId, new Map());
        sshBackgroundJobs.get(connectionId).set(pid, { pid, logFile, command });
        resolve({ pid, logFile });
      });
    });
  });
}

function sshCheckBackground(connectionId, pid, logFile, lines) {
  return new Promise((resolve, reject) => {
    const conn = sshConnections.get(connectionId);
    if (!conn) return reject(new Error('Koneksi tidak ditemukan: ' + connectionId));
    const pidNum = parseInt(pid, 10);
    if (isNaN(pidNum)) return reject(new Error('PID tidak valid'));
    const job = sshBackgroundJobs.get(connectionId)?.get(String(pid));
    const effectiveLog = logFile || job?.logFile;
    const n = lines || 200;
    const tailPart = effectiveLog ? `tail -n ${parseInt(n, 10)} ${shQuote(effectiveLog)} 2>/dev/null` : `echo "(tidak ada log file diketahui untuk PID ini)"`;
    const cmd = `if kill -0 ${pidNum} 2>/dev/null; then echo "STATUS: running"; else echo "STATUS: stopped"; fi; echo "---LOG (${effectiveLog || '-'})---"; ${tailPart}`;
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', d => stdout += d);
      stream.stderr.on('data', d => stderr += d);
      stream.on('close', () => resolve(stdout.trim() || stderr.trim()));
    });
  });
}

function sshKillBackground(connectionId, pid, signal) {
  return new Promise((resolve, reject) => {
    const conn = sshConnections.get(connectionId);
    if (!conn) return reject(new Error('Koneksi tidak ditemukan: ' + connectionId));
    const pidNum = parseInt(pid, 10);
    if (isNaN(pidNum)) return reject(new Error('PID tidak valid'));
    const sig = signal || 'TERM';
    if (!/^[A-Z0-9]+$/i.test(sig)) return reject(new Error('Signal tidak valid'));
    conn.exec(`kill -${sig} ${pidNum} && echo "Proses ${pidNum} dikirim signal ${sig}" || echo "Gagal kill (mungkin proses sudah berhenti)"`, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', d => stdout += d);
      stream.stderr.on('data', d => stderr += d);
      stream.on('close', () => {
        sshBackgroundJobs.get(connectionId)?.delete(String(pid));
        resolve(stdout.trim() || stderr.trim());
      });
    });
  });
}

async function sshUpload(connectionId, localPath, remotePath) {
  const config = sshConfigs.get(connectionId);
  if (!config) throw new Error('Koneksi tidak ditemukan: ' + connectionId);
  const sftp = new SftpClient();
  try {
    await sftp.connect(config);
    await sftp.put(localPath, remotePath);
    await sftp.end();
    return `File berhasil diupload: ${localPath} → ${remotePath}`;
  } catch (err) {
    await sftp.end().catch(() => {});
    throw err;
  }
}

async function sshDownload(connectionId, remotePath, localPath) {
  const config = sshConfigs.get(connectionId);
  if (!config) throw new Error('Koneksi tidak ditemukan: ' + connectionId);
  const sftp = new SftpClient();
  try {
    await sftp.connect(config);
    await sftp.get(remotePath, localPath);
    await sftp.end();
    return `File berhasil didownload: ${remotePath} → ${localPath}`;
  } catch (err) {
    await sftp.end().catch(() => {});
    throw err;
  }
}

// Auth & rate limiting
const authCodes = new Map();
const accessTokens = new Map();
const failedAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const SESSION_EXPIRE_MS = 5 * 60 * 1000;

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
}

function isRateLimited(ip) {
  const data = failedAttempts.get(ip);
  if (!data) return false;
  if (Date.now() - data.lockedAt < LOCKOUT_MS) return true;
  failedAttempts.delete(ip);
  return false;
}

function recordFailedAttempt(ip) {
  const data = failedAttempts.get(ip) || { count: 0, lockedAt: null };
  data.count++;
  if (data.count >= MAX_ATTEMPTS) { data.lockedAt = Date.now(); console.error(`[SECURITY] IP ${ip} diblokir`); }
  failedAttempts.set(ip, data);
  return data.count;
}

function resetAttempts(ip) { failedAttempts.delete(ip); }

function createServer(sshDefaultConfig) {
  const server = new Server(
    { name: 'vps2-mcp', version: '3.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ssh_connect',
        description: sshDefaultConfig
          ? `Buat koneksi SSH ke server remote. Target default (${sshDefaultConfig.username}@${sshDefaultConfig.host}:${sshDefaultConfig.port}) sudah dikonfigurasi saat otorisasi OAuth — cukup panggil dengan connectionId saja, tanpa perlu host/username/password/privateKey.`
          : 'Buat koneksi SSH ke server remote',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID unik untuk koneksi ini' },
            host: { type: 'string', description: 'Hostname atau IP server (opsional jika sudah diset saat otorisasi OAuth)' },
            port: { type: 'number', description: 'Port SSH (default: 22, atau yang diset saat otorisasi)' },
            username: { type: 'string', description: 'Username SSH (opsional jika sudah diset saat otorisasi OAuth)' },
            password: { type: 'string', description: 'Password SSH (opsional)' },
            privateKey: { type: 'string', description: 'Isi private key SSH (opsional)' },
            whitelist: { type: 'array', items: { type: 'string' }, description: 'Whitelist perintah (regex), opsional' },
            blacklist: { type: 'array', items: { type: 'string' }, description: 'Blacklist perintah (regex), opsional' }
          },
          required: ['connectionId']
        }
      },
      {
        name: 'ssh_exec',
        description: 'Jalankan perintah di server SSH yang sudah terhubung',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            command: { type: 'string', description: 'Perintah yang akan dijalankan' },
            whitelist: { type: 'array', items: { type: 'string' }, description: 'Override whitelist (regex), opsional' },
            blacklist: { type: 'array', items: { type: 'string' }, description: 'Override blacklist (regex), opsional' }
          },
          required: ['connectionId', 'command']
        }
      },
      {
        name: 'ssh_upload',
        description: 'Upload file dari server VPS ini ke server SSH remote',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            localPath: { type: 'string', description: 'Path file lokal di VPS ini' },
            remotePath: { type: 'string', description: 'Path tujuan di server remote' }
          },
          required: ['connectionId', 'localPath', 'remotePath']
        }
      },
      {
        name: 'ssh_download',
        description: 'Download file dari server SSH remote ke VPS ini',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            remotePath: { type: 'string', description: 'Path file di server remote' },
            localPath: { type: 'string', description: 'Path tujuan di VPS ini' }
          },
          required: ['connectionId', 'remotePath', 'localPath']
        }
      },
      {
        name: 'ssh_exec_persistent',
        description: 'Jalankan perintah pada shell SSH persisten (satu sesi shell bertahan antar panggilan) — cd, source venv/bin/activate, export ENV, dsb tetap nyambung ke panggilan berikutnya untuk connectionId yang sama. Shell dibuat otomatis saat pertama kali dipakai.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            command: { type: 'string', description: 'Perintah yang akan dijalankan di shell persisten' },
            timeoutMs: { type: 'number', description: 'Timeout menunggu output dalam ms (default: 30000)' },
            whitelist: { type: 'array', items: { type: 'string' }, description: 'Override whitelist (regex), opsional' },
            blacklist: { type: 'array', items: { type: 'string' }, description: 'Override blacklist (regex), opsional' }
          },
          required: ['connectionId', 'command']
        }
      },
      {
        name: 'ssh_close_shell',
        description: 'Tutup shell persisten untuk connectionId tertentu (tidak menutup koneksi SSH itu sendiri)',
        inputSchema: {
          type: 'object',
          properties: { connectionId: { type: 'string', description: 'ID koneksi SSH' } },
          required: ['connectionId']
        }
      },
      {
        name: 'ssh_edit_file',
        description: 'Edit file di server remote in-place (replace string tanpa download/upload). Mirip tool Edit lokal: oldString harus unik di file kecuali replaceAll=true.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            remotePath: { type: 'string', description: 'Path file di server remote' },
            oldString: { type: 'string', description: 'String yang akan dicari & diganti' },
            newString: { type: 'string', description: 'String pengganti' },
            replaceAll: { type: 'boolean', description: 'Ganti semua kemunculan (default: false, error jika oldString muncul >1 kali)' },
            whitelist: { type: 'array', items: { type: 'string' }, description: 'Override whitelist (regex, dicek terhadap "EDIT_FILE <remotePath>"), opsional' },
            blacklist: { type: 'array', items: { type: 'string' }, description: 'Override blacklist (regex, dicek terhadap "EDIT_FILE <remotePath>"), opsional' }
          },
          required: ['connectionId', 'remotePath', 'oldString', 'newString']
        }
      },
      {
        name: 'ssh_exec_background',
        description: 'Jalankan perintah long-running di background (via nohup, output diarahkan ke log file di /tmp). Mengembalikan PID dan path log file untuk dicek/dihentikan nanti.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            command: { type: 'string', description: 'Perintah yang akan dijalankan di background' },
            whitelist: { type: 'array', items: { type: 'string' }, description: 'Override whitelist (regex), opsional' },
            blacklist: { type: 'array', items: { type: 'string' }, description: 'Override blacklist (regex), opsional' }
          },
          required: ['connectionId', 'command']
        }
      },
      {
        name: 'ssh_check_background',
        description: 'Cek status proses background (running/stopped) berdasarkan PID, sekaligus tampilkan tail log file-nya',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            pid: { type: 'string', description: 'PID proses (dari hasil ssh_exec_background)' },
            logFile: { type: 'string', description: 'Path log file (opsional, otomatis diingat dari ssh_exec_background jika tidak diisi)' },
            lines: { type: 'number', description: 'Jumlah baris log terakhir yang ditampilkan (default: 200)' }
          },
          required: ['connectionId', 'pid']
        }
      },
      {
        name: 'ssh_kill_background',
        description: 'Hentikan proses background berdasarkan PID',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            pid: { type: 'string', description: 'PID proses yang akan dihentikan' },
            signal: { type: 'string', description: 'Signal kill (default: TERM), mis. KILL, INT' }
          },
          required: ['connectionId', 'pid']
        }
      },
      {
        name: 'ssh_list_files',
        description: 'Tampilkan daftar file di direktori server SSH',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            remotePath: { type: 'string', description: 'Path direktori di server remote' }
          },
          required: ['connectionId', 'remotePath']
        }
      },
      {
        name: 'ssh_disconnect',
        description: 'Tutup koneksi SSH',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH yang akan ditutup' }
          },
          required: ['connectionId']
        }
      },
      {
        name: 'ssh_list_connections',
        description: 'Tampilkan daftar koneksi SSH yang aktif',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'ssh_connect') {
      try {
        const base = sshDefaultConfig || {};
        const host = args.host || base.host;
        const username = args.username || base.username;
        const port = args.port || base.port || 22;
        if (!host || !username) {
          return { content: [{ type: 'text', text: 'SSH Error: host/username tidak diset. Isi lewat argumen tool, atau lakukan otorisasi OAuth ulang dan isi Host/Username di halaman auth.' }] };
        }
        const config = { host, port, username };
        if (args.password) config.password = args.password;
        else if (args.privateKey) config.privateKey = args.privateKey;
        else if (base.privateKey) config.privateKey = base.privateKey;
        else if (base.password) config.password = base.password;
        if (args.whitelist) config.whitelist = args.whitelist;
        if (args.blacklist) config.blacklist = args.blacklist;
        await sshConnect(args.connectionId, config);
        return { content: [{ type: 'text', text: `Berhasil terhubung ke ${username}@${host}:${port} (ID: ${args.connectionId})` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'SSH Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_exec') {
      try {
        const config = sshConfigs.get(args.connectionId) || {};
        const whitelist = args.whitelist || config.whitelist || [];
        const blacklist = args.blacklist || config.blacklist || [];
        const result = await sshExec(args.connectionId, args.command, whitelist, blacklist);
        return { content: [{ type: 'text', text: result.stdout || result.stderr || '(tidak ada output)' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'SSH Exec Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_exec_persistent') {
      try {
        const config = sshConfigs.get(args.connectionId) || {};
        const whitelist = args.whitelist || config.whitelist || [];
        const blacklist = args.blacklist || config.blacklist || [];
        const result = await sshExecPersistent(args.connectionId, args.command, whitelist, blacklist, args.timeoutMs);
        return { content: [{ type: 'text', text: (result.output || '(tidak ada output)') + `\n[exit code: ${result.exitCode}]` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'SSH Exec Persistent Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_close_shell') {
      sshCloseShell(args.connectionId);
      return { content: [{ type: 'text', text: 'Shell persisten untuk ' + args.connectionId + ' ditutup' }] };
    }

    if (name === 'ssh_edit_file') {
      try {
        const config = sshConfigs.get(args.connectionId) || {};
        const whitelist = args.whitelist || config.whitelist || [];
        const blacklist = args.blacklist || config.blacklist || [];
        const result = await sshEditFile(args.connectionId, args.remotePath, args.oldString, args.newString, args.replaceAll, whitelist, blacklist);
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'SSH Edit File Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_exec_background') {
      try {
        const config = sshConfigs.get(args.connectionId) || {};
        const whitelist = args.whitelist || config.whitelist || [];
        const blacklist = args.blacklist || config.blacklist || [];
        const result = await sshExecBackground(args.connectionId, args.command, whitelist, blacklist);
        return { content: [{ type: 'text', text: `Proses dijalankan di background. PID: ${result.pid}, Log: ${result.logFile}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'SSH Exec Background Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_check_background') {
      try {
        const result = await sshCheckBackground(args.connectionId, args.pid, args.logFile, args.lines);
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'SSH Check Background Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_kill_background') {
      try {
        const result = await sshKillBackground(args.connectionId, args.pid, args.signal);
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'SSH Kill Background Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_upload') {
      try {
        const result = await sshUpload(args.connectionId, args.localPath, args.remotePath);
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Upload Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_download') {
      try {
        const result = await sshDownload(args.connectionId, args.remotePath, args.localPath);
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Download Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_list_files') {
      try {
        const files = await sshListFiles(args.connectionId, args.remotePath);
        return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'SSH List Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_disconnect') {
      const conn = sshConnections.get(args.connectionId);
      if (!conn) return { content: [{ type: 'text', text: 'Koneksi tidak ditemukan: ' + args.connectionId }] };
      sshCloseShell(args.connectionId);
      sshBackgroundJobs.delete(args.connectionId);
      conn.end();
      sshConnections.delete(args.connectionId);
      sshConfigs.delete(args.connectionId);
      return { content: [{ type: 'text', text: 'Koneksi ' + args.connectionId + ' ditutup' }] };
    }

    if (name === 'ssh_list_connections') {
      const list = [...sshConnections.keys()];
      return { content: [{ type: 'text', text: list.length ? 'Koneksi aktif: ' + list.join(', ') : 'Tidak ada koneksi aktif' }] };
    }

    return { content: [{ type: 'text', text: 'Tool tidak ditemukan' }] };
  });

  return server;
}

const cliArgs = process.argv.slice(2);

if (cliArgs.includes('--http')) {
  const PORT = process.env.PORT || 3100;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use((req, res, next) => { console.error('[REQ]', req.method, req.path); next(); });

  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    res.json({ resource: BASE_URL, authorization_servers: [BASE_URL], bearer_methods_supported: ['header'], resource_documentation: BASE_URL });
  });

  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.json({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/oauth/token`,
      registration_endpoint: `${BASE_URL}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256']
    });
  });

  app.post('/oauth/register', (req, res) => {
    const { client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method } = req.body;
    const client_id = crypto.randomBytes(16).toString('hex');
    const client_secret = crypto.randomBytes(32).toString('hex');
    console.error('[DCR] Client registered:', client_name, 'redirect_uris:', JSON.stringify(redirect_uris));
    res.status(201).json({
      client_id, client_secret,
      client_name: client_name || 'MCP Client',
      redirect_uris: redirect_uris || [],
      grant_types: grant_types || ['authorization_code'],
      response_types: response_types || ['code'],
      token_endpoint_auth_method: token_endpoint_auth_method || 'client_secret_post'
    });
  });

  app.get('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;
    if (!client_id) return res.status(400).send('Missing client_id');
    const ip = getClientIP(req);
    if (isRateLimited(ip)) return res.status(429).send('<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px"><h2>🚫 Terlalu Banyak Percobaan</h2><p>IP Anda diblokir 15 menit.</p></body></html>');
    const tempId = crypto.randomBytes(8).toString('hex');
    authCodes.set('pending_' + tempId, { client_id, redirect_uri, state, code_challenge, code_challenge_method, createdAt: Date.now() });
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MCP VPS2 - Izinkan Akses</title>
<style>body{font-family:sans-serif;max-width:460px;margin:60px auto;padding:20px}h2{color:#333}.info{background:#f5f5f5;padding:12px;border-radius:8px;margin:16px 0;font-size:14px}.field{margin:14px 0}label{display:block;font-size:14px;color:#555;margin-bottom:6px;font-weight:600}input[type=text],input[type=password],input[type=number],textarea{width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:15px;box-sizing:border-box;font-family:inherit}textarea{font-family:monospace;font-size:13px;min-height:90px;resize:vertical}.row{display:flex;gap:10px}.row .field{flex:1}.authmethod{display:flex;gap:16px;margin-bottom:10px;font-size:14px;font-weight:normal}.authmethod label{display:flex;align-items:center;gap:6px;font-weight:normal;margin:0}fieldset{border:1px solid #e2e2e2;border-radius:8px;padding:14px;margin:16px 0}legend{font-size:14px;font-weight:600;color:#333;padding:0 6px}button{padding:10px 24px;border:none;border-radius:6px;cursor:pointer;font-size:15px;margin-top:8px}.allow{background:#2563eb;color:white;margin-right:8px}.deny{background:#eee;color:#333}.timer{font-size:12px;color:#999;margin-top:8px}.hint{font-size:12px;color:#888;margin-top:-2px;margin-bottom:8px}</style>
</head><body>
<h2>🔐 MCP VPS2 - SSH Server</h2>
<p>Masukkan detail koneksi SSH dan password untuk mengizinkan akses.</p>
<div class="info"><b>Akses yang diberikan:</b><br>• Koneksi SSH ke server remote<br>• Eksekusi perintah via SSH<br>• Upload & Download file via SSH<br>• Browse file via SSH</div>
<form method="POST" action="/oauth/approve">
<input type="hidden" name="tempId" value="${tempId}">
<fieldset>
<legend>Target VPS (SSH)</legend>
<div class="field"><label>Host / IP</label><input type="text" name="sshHost" placeholder="mis. 103.xxx.xxx.xxx" required></div>
<div class="row">
<div class="field"><label>Username SSH</label><input type="text" name="sshUsername" placeholder="root" required></div>
<div class="field"><label>Port</label><input type="number" name="sshPort" placeholder="22" value="22"></div>
</div>
<div class="authmethod">
<label><input type="radio" name="sshAuthMethod" value="password" checked onchange="document.getElementById('pwField').style.display='block';document.getElementById('keyField').style.display='none'"> Password</label>
<label><input type="radio" name="sshAuthMethod" value="privateKey" onchange="document.getElementById('pwField').style.display='none';document.getElementById('keyField').style.display='block'"> Private Key</label>
</div>
<div class="field" id="pwField"><label>Password SSH</label><input type="password" name="sshPassword" placeholder="Password SSH..."></div>
<div class="field" id="keyField" style="display:none"><label>Private Key (isi lengkap)</label><textarea name="sshPrivateKey" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"></textarea></div>
</fieldset>
<div class="field"><label>🔑 Password Approval</label><input type="password" name="password" placeholder="Masukkan password approval..." required></div>
<p class="hint">Detail SSH di atas disimpan hanya di memori server selama sesi akses ini aktif, tidak pernah melewati percakapan Claude.</p>
<button type="submit" name="action" value="allow" class="allow">✅ Izinkan</button>
<button type="submit" name="action" value="deny" class="deny">❌ Tolak</button>
</form>
<p class="timer">⏱ Sesi expired dalam <span id="countdown">5:00</span></p>
<script>let s=300;const e=document.getElementById('countdown');const i=setInterval(()=>{s--;if(s<=0){clearInterval(i);e.textContent='EXPIRED';}else{e.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}},1000);</script>
</body></html>`);
  });

  app.post('/oauth/approve', async (req, res) => {
    const { tempId, action, password, sshHost, sshUsername, sshPort, sshAuthMethod, sshPassword, sshPrivateKey } = req.body;
    const ip = getClientIP(req);
    if (isRateLimited(ip)) return res.status(429).send('<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px"><h2>🚫 IP Diblokir</h2><p>Coba lagi setelah 15 menit.</p></body></html>');
    const pending = authCodes.get('pending_' + tempId);
    if (!pending) return res.status(400).send('<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px"><h2>❌ Sesi Expired</h2><p>Silakan ulangi dari Claude.ai.</p></body></html>');
    if (Date.now() - pending.createdAt > SESSION_EXPIRE_MS) {
      authCodes.delete('pending_' + tempId);
      return res.status(400).send('<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px"><h2>⏱ Sesi Expired</h2><p>Silakan ulangi dari Claude.ai.</p></body></html>');
    }
    if (action === 'deny') { authCodes.delete('pending_' + tempId); return res.redirect(`${pending.redirect_uri}?error=access_denied&state=${pending.state}`); }
    await new Promise(r => setTimeout(r, 2000));
    if (password !== APPROVE_PASSWORD) {
      const attempts = recordFailedAttempt(ip);
      const remaining = MAX_ATTEMPTS - attempts;
      return res.status(401).send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px"><h2>❌ ${remaining > 0 ? `Password salah. Sisa: ${remaining}` : 'IP diblokir 15 menit.'}</h2><a href="javascript:history.back()" style="color:#2563eb">← Coba lagi</a></body></html>`);
    }
    if (!sshHost || !sshUsername) {
      return res.status(400).send('<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:20px"><h2>❌ Data SSH tidak lengkap</h2><p>Host dan Username SSH wajib diisi.</p><a href="javascript:history.back()" style="color:#2563eb">← Coba lagi</a></body></html>');
    }
    resetAttempts(ip);
    authCodes.delete('pending_' + tempId);
    const { redirect_uri, state, code_challenge, code_challenge_method, client_id } = pending;
    const sshDefaultConfig = {
      host: sshHost,
      port: sshPort ? parseInt(sshPort, 10) : 22,
      username: sshUsername,
    };
    if (sshAuthMethod === 'privateKey' && sshPrivateKey) sshDefaultConfig.privateKey = sshPrivateKey;
    else if (sshPassword) sshDefaultConfig.password = sshPassword;
    const code = crypto.randomBytes(16).toString('hex');
    authCodes.set(code, { client_id, redirect_uri, code_challenge, code_challenge_method, used: false, sshDefaultConfig });
    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    console.error(`[AUTH] Akses diizinkan untuk IP ${ip} (target SSH: ${sshUsername}@${sshHost}:${sshDefaultConfig.port})`);
    res.redirect(url.toString());
  });

  app.post('/oauth/token', (req, res) => {
    const { grant_type, code, code_verifier } = req.body;
    if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
    const stored = authCodes.get(code);
    if (!stored || stored.used) return res.status(400).json({ error: 'invalid_grant' });
    if (stored.code_challenge) {
      const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
      if (hash !== stored.code_challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    stored.used = true;
    const access_token = crypto.randomBytes(32).toString('hex');
    accessTokens.set(access_token, { created: Date.now(), sshDefaultConfig: stored.sshDefaultConfig || null });
    res.json({ access_token, token_type: 'Bearer', expires_in: 86400 });
  });

  function authMiddleware(req, res, next) {
    if (req.path === '/health' || req.path.startsWith('/oauth') || req.path.startsWith('/.well-known')) return next();
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token || '');
    const tokenData = accessTokens.get(token);
    if (tokenData) { req.sshDefaultConfig = tokenData.sshDefaultConfig || null; return next(); }
    if (token === MCP_TOKEN) { req.sshDefaultConfig = null; return next(); }
    return res.status(401)
      .set('WWW-Authenticate', `Bearer realm="${BASE_URL}", authorization_uri="${BASE_URL}/oauth/authorize", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`)
      .json({ error: 'unauthorized', resource_metadata: `${BASE_URL}/.well-known/oauth-protected-resource` });
  }
  app.use(authMiddleware);

  const transports = {};
  app.post('/', async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    req.headers["accept"] = "application/json, text/event-stream";
    let t;
    if (sid && transports[sid]) { t = transports[sid]; } else {
      t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomBytes(16).toString('hex') });
      const srv = createServer(req.sshDefaultConfig);
      t.onclose = () => { if (t.sessionId) delete transports[t.sessionId]; };
      await srv.connect(t);
      await t.handleRequest(req, res, req.body);
      if (t.sessionId) transports[t.sessionId] = t;
      return;
    }
    await t.handleRequest(req, res, req.body);
  });

  app.get('/', async (req, res) => {
    const sid2 = req.headers['mcp-session-id'];
    if (!sid2 || !transports[sid2]) return res.status(400).json({ error: "no session" });
    await transports[sid2].handleRequest(req, res);
  });

  app.delete('/', async (req, res) => {
    const sid3 = req.headers['mcp-session-id'];
    if (sid3 && transports[sid3]) { await transports[sid3].close(); delete transports[sid3]; }
    res.status(200).end();
  });

  app.get('/sse', async (req, res) => {
    const server = createServer(req.sshDefaultConfig);
    const transport = new SSEServerTransport('/message', res);
    transports[transport.sessionId] = transport;
    res.on('close', () => delete transports[transport.sessionId]);
    await server.connect(transport);
  });

  app.post('/message', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports[sessionId];
    if (!transport) return res.status(404).send('Session tidak ditemukan');
    await transport.handlePostMessage(req, res, req.body);
  });

  app.get('/health', (req, res) => res.json({
    status: 'ok', version: '3.1.0', mode: 'http', auth: 'oauth2-password-protected',
    tools: ['ssh_connect', 'ssh_exec', 'ssh_exec_persistent', 'ssh_close_shell', 'ssh_edit_file', 'ssh_exec_background', 'ssh_check_background', 'ssh_kill_background', 'ssh_upload', 'ssh_download', 'ssh_list_files', 'ssh_disconnect', 'ssh_list_connections'],
    ssh_connections_active: sshConnections.size
  }));

  app.listen(PORT, () => {
    console.error(`MCP SSH Server v3.1.0: http://0.0.0.0:${PORT}`);
    console.error(`Mode: OAuth2 + Password + Rate Limiting + DCR + Upload/Download + Whitelist/Blacklist`);
  });

} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP SSH Server v3.1.0 siap! (stdio mode)');
}
