import { LOGIN_TTL_MS, claudeAppDomain } from './browser-embed-security.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { readFileSync } from 'fs';
import { resolve, dirname, extname, normalize, sep } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { Client } from 'ssh2';
import SftpClient from 'ssh2-sftp-client';
import {
  CHAT_WORKFLOW_INSTRUCTIONS,
  assertAbsolutePath,
  assertCheckpointId,
  buildRepoSnapshotCommand,
  buildRepoVerifyCommand,
  buildRepoWorktreeCommand,
  buildRepoReviewCommand,
  buildRepoCommitCommand,
  buildRepoPushCommand,
  normalizeCheckpoint,
  containsSecretLike,
  parseTaggedOutput,
  shellQuote as workflowShellQuote,
  truncateText
} from './workflow.js';
import {
  assertAllowedImagePath,
  assertDeviceId,
  assertImageBuffer,
  normalizeImageMaxBytes,
  toImageContent
} from './image-tools.js';
import { normalizeAllowedBrowserHosts, runBrowserSmoke } from './browser-smoke.js';
import { assertWorkspaceId, normalizeWorkspaceTasks, normalizeWorkspaceManifest } from './workspace-tools.js';
import { assertProjectId, normalizeProjectProfile, updateProjectProfile } from './project-profile.js';
import {
  assertAgentBoardId,
  createAgentBoardState,
  validateAgentBoardState,
  expireAgentLeases,
  claimAgentTask,
  heartbeatAgentTask,
  submitAgentTask,
  releaseAgentTask,
  summarizeAgentBoard,
  canRemoveAgentBoard,
  assertAgentBoardWorkspaceMapping
} from './agent-board.js';

import {
  browserOpen, browserSnapshot, browserExtractText, browserExtractTranscript, browserClick, browserType, browserSelect,
  browserWait, browserScreenshot, browserExportPdf, browserExecuteJs, browserTabs, browserBack, browserReload, browserSetMode
} from './browser-tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const envFile = readFileSync(resolve(__dirname, '.env'), 'utf-8');
  envFile.split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
} catch {}

const MCP_VERSION = '3.10.0';
const MCP_TOKEN = process.env.MCP_TOKEN || '';
const APPROVE_PASSWORD = process.env.APPROVE_PASSWORD || '';
const BASE_URL = process.env.BASE_URL || 'https://mcp-vps2.hijrah-attauhid.or.id';
const BROWSER_UI_URI = 'ui://attauhid/browser-v9.html';
const BROWSER_SCREENSHOT_UI_URI = 'ui://attauhid/browser-screenshot-v1.html';
const BROWSER_UI_URI_RE = /^ui:\/\/attauhid\/(?:browser-v\d+|browser-card-v\d+)\.html$/;
const BROWSER_VIEW_URL = 'https://browser-vps.hijrah-attauhid.or.id/embed/login';
function browserViewLink() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expires = Date.now() + LOGIN_TTL_MS;
  const sig = crypto.createHmac('sha256', APPROVE_PASSWORD).update('browser-view:' + nonce + ':' + expires).digest('hex');
  return BROWSER_VIEW_URL + '?nonce=' + nonce + '&expires=' + expires + '&sig=' + sig;
}


const ADB_TUNNEL_HOST = process.env.ADB_TUNNEL_HOST || '127.0.0.1';
const ADB_TUNNEL_PORT = Number.parseInt(process.env.ADB_TUNNEL_PORT || '15037', 10);
if (ADB_TUNNEL_HOST !== '127.0.0.1' || !Number.isInteger(ADB_TUNNEL_PORT) || ADB_TUNNEL_PORT < 1 || ADB_TUNNEL_PORT > 65535) {
  throw new Error('ADB tunnel harus menggunakan 127.0.0.1 dan port valid');
}
const BROWSER_SMOKE_ALLOWED_HOSTS = normalizeAllowedBrowserHosts(process.env.BROWSER_SMOKE_ALLOWED_HOSTS || '127.0.0.1,localhost');
const BROWSER_SMOKE_LOCAL_PORTS = (process.env.BROWSER_SMOKE_LOCAL_PORTS || '3100').split(',').map(v => Number(v.trim()));
if (!BROWSER_SMOKE_LOCAL_PORTS.length || BROWSER_SMOKE_LOCAL_PORTS.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('BROWSER_SMOKE_LOCAL_PORTS tidak valid');
const MAX_BROWSER_SMOKE_CONCURRENCY = 1;
const WORKSPACE_VERIFY_CONCURRENCY = Number(process.env.WORKSPACE_VERIFY_CONCURRENCY || '2');
if (!Number.isInteger(WORKSPACE_VERIFY_CONCURRENCY) || WORKSPACE_VERIFY_CONCURRENCY < 1 || WORKSPACE_VERIFY_CONCURRENCY > 3) throw new Error('WORKSPACE_VERIFY_CONCURRENCY harus 1-3');
let browserSmokeActive = 0;
const agentBoardLocks = new Map();
const MAX_AGENT_BOARD_BYTES = 128 * 1024;

// SSH connection pool
const sshConnections = new Map();
const sshConfigs = new Map(); // simpan config untuk SFTP reuse
const sshShells = new Map(); // connectionId -> { stream, buffer } (shell persisten)
const sshBackgroundJobs = new Map(); // connectionId -> Set of { pid, logFile, command }
const uploadSlots = new Map(); // one-time browser upload tokens -> { connectionId, remotePath, maxBytes, expiresAt }
const DEFAULT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_UPLOAD_TTL_SECONDS = 10 * 60;
const MAX_ACTIVE_UPLOAD_SLOTS = 100;
const UPLOAD_ALLOWED_ROOTS = (process.env.UPLOAD_ALLOWED_ROOTS || '/home/attauhid/private/mcp-uploads')
  .split(',').map(v => v.trim()).filter(Boolean).map(v => resolve(v));
const IMAGE_READ_ALLOWED_ROOTS = (process.env.IMAGE_READ_ALLOWED_ROOTS || '/tmp,/home/attauhid/browser-agent/screenshots,/home/attauhid/private/mcp-uploads')
  .split(',').map(v => v.trim()).filter(Boolean).map(v => resolve(v));
const UPLOAD_RATE_WINDOW_MS = 60 * 1000;
const UPLOAD_RATE_MAX_PER_IP = 20;
const uploadRate = new Map();
const UPLOAD_KINDS = {
  image: new Set(['.png', '.jpg', '.jpeg', '.webp']),
  pdf: new Set(['.pdf']),
  zip: new Set(['.zip']),
  apk: new Set(['.apk'])
};

function isPathInside(root, candidate) {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r + sep);
}

function validateUploadDestination(remotePath, kind = 'image', allowedRoots = UPLOAD_ALLOWED_ROOTS) {
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || remotePath.includes('\0')) {
    throw new Error('remotePath harus path absolut yang valid');
  }
  const normalized = resolve(normalize(remotePath));
  if (!Array.isArray(allowedRoots) || !allowedRoots.length || !allowedRoots.some(root => isPathInside(root, normalized))) {
    throw new Error('remotePath di luar direktori upload yang diizinkan');
  }
  if (!UPLOAD_KINDS[kind]) throw new Error('kind tidak didukung');
  const ext = extname(normalized).toLowerCase();
  if (!UPLOAD_KINDS[kind].has(ext)) throw new Error(`Ekstensi ${ext || '(tanpa ekstensi)'} tidak diizinkan untuk kind=${kind}`);
  return normalized;
}

function detectUploadKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && [0x03,0x05,0x07].includes(buf[2]) && [0x04,0x06,0x08].includes(buf[3])) return 'zip';
  return null;
}

function isUploadRateLimited(ip) {
  const now = Date.now();
  const entry = uploadRate.get(ip);
  if (!entry || now - entry.startedAt >= UPLOAD_RATE_WINDOW_MS) {
    uploadRate.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > UPLOAD_RATE_MAX_PER_IP;
}

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

async function sshUploadBuffer(connectionId, buffer, remotePath, allowOverwrite = false, allowedRoots = UPLOAD_ALLOWED_ROOTS) {
  const config = sshConfigs.get(connectionId);
  if (!config) throw new Error('Koneksi tidak ditemukan: ' + connectionId);
  const sftp = new SftpClient();
  try {
    await sftp.connect(config);
    const realParent = await sftp.realPath(dirname(remotePath));
    assertAllowedImagePath(realParent, allowedRoots);
    const existingType = await sftp.exists(remotePath);
    if (existingType === 'l' || (existingType && existingType !== '-')) throw new Error('destination_not_regular_file');
    if (!allowOverwrite) {
      const exists = await sftp.exists(remotePath);
      if (exists) throw new Error('destination_exists');
    }
    await sftp.put(buffer, remotePath, { writeStreamOptions: { flags: allowOverwrite ? 'w' : 'wx', mode: 0o600 } });
    await sftp.end();
    return `File berhasil diupload langsung: ${remotePath} (${buffer.length} bytes)`;
  } catch (err) {
    await sftp.end().catch(() => {});
    throw err;
  }
}

function createUploadSlot(connectionId, remotePath, maxBytes, expiresInSeconds, kind = 'image', allowOverwrite = false, allowedRoots = UPLOAD_ALLOWED_ROOTS) {
  if (!sshConfigs.has(connectionId)) throw new Error('Koneksi tidak ditemukan: ' + connectionId);
  const safeRemotePath = validateUploadDestination(remotePath, kind, allowedRoots);
  const now = Date.now();
  for (const [existingToken, slot] of uploadSlots) {
    if (slot.expiresAt <= now) uploadSlots.delete(existingToken);
  }
  if (uploadSlots.size >= MAX_ACTIVE_UPLOAD_SLOTS) throw new Error('Terlalu banyak upload slot aktif; tunggu slot lama kedaluwarsa');
  const size = Number.isFinite(Number(maxBytes)) ? Math.floor(Number(maxBytes)) : DEFAULT_UPLOAD_MAX_BYTES;
  if (size < 1 || size > MAX_UPLOAD_MAX_BYTES) throw new Error(`maxBytes harus 1..${MAX_UPLOAD_MAX_BYTES}`);
  const ttl = Number.isFinite(Number(expiresInSeconds)) ? Math.floor(Number(expiresInSeconds)) : DEFAULT_UPLOAD_TTL_SECONDS;
  if (ttl < 60 || ttl > 3600) throw new Error('expiresInSeconds harus 60..3600');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttl * 1000;
  uploadSlots.set(token, { connectionId, remotePath: safeRemotePath, maxBytes: size, expiresAt, kind, allowOverwrite: !!allowOverwrite, allowedRoots: [...allowedRoots] });
  return {
    uploadUrl: `${BASE_URL}/upload-ui#token=${token}`,
    remotePath: safeRemotePath,
    kind,
    allowOverwrite: !!allowOverwrite,
    maxBytes: size,
    expiresAt: new Date(expiresAt).toISOString(),
    instructions: 'Buka uploadUrl di browser Work, pilih file lokal, lalu klik Upload. File dikirim sebagai binary langsung ke VPS; jangan encode Base64.'
  };
}

async function sshWriteFile(connectionId, remotePath, content, encoding) {
  const config = sshConfigs.get(connectionId);
  if (!config) throw new Error('Koneksi tidak ditemukan: ' + connectionId);
  const sftp = new SftpClient();
  try {
    const buf = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
    await sftp.connect(config);
    await sftp.put(buf, remotePath);
    await sftp.end();
    return `File berhasil ditulis: ${remotePath} (${buf.length} bytes)`;
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

async function sshReadImageBuffer(connectionId, remotePath, maxBytes, allowedRoots = IMAGE_READ_ALLOWED_ROOTS) {
  const config = sshConfigs.get(connectionId);
  if (!config) throw new Error('Koneksi tidak ditemukan: ' + connectionId);
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || remotePath.includes('\0')) {
    throw new Error('remotePath harus path absolut yang valid');
  }
  const limit = normalizeImageMaxBytes(maxBytes);
  const sftp = new SftpClient();
  try {
    await sftp.connect(config);
    const realPath = await sftp.realPath(remotePath);
    if (!realPath) throw new Error('path gambar tidak ditemukan');
    assertAllowedImagePath(realPath, allowedRoots);
    const stat = await sftp.stat(realPath);
    if (!stat || typeof stat.size !== 'number') throw new Error('metadata gambar tidak valid');
    if (stat.size <= 0) throw new Error('file gambar kosong');
    if (stat.size > limit) throw new Error(`gambar terlalu besar (${stat.size} bytes > ${limit})`);
    const data = await sftp.get(realPath);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const mimeType = assertImageBuffer(buffer, limit);
    return { buffer, mimeType, realPath, size: buffer.length };
  } finally {
    await sftp.end().catch(() => {});
  }
}

async function adbScreenshotVisual(connectionId, deviceId, maxBytes) {
  const serial = assertDeviceId(deviceId);
  const limit = normalizeImageMaxBytes(maxBytes);
  const tempPath = `/tmp/mcp-adb-screen-${crypto.randomBytes(8).toString('hex')}.png`;
  const command = `umask 077; adb -H ${ADB_TUNNEL_HOST} -P ${ADB_TUNNEL_PORT} -s ${shQuote(serial)} exec-out screencap -p > ${shQuote(tempPath)}`;
  try {
    const capture = await sshExec(connectionId, command);
    if (capture.exitCode !== 0) {
      throw new Error(truncateText(capture.stderr || capture.stdout || `adb screencap gagal (${capture.exitCode})`, 4000));
    }
    return await sshReadImageBuffer(connectionId, tempPath, limit);
  } finally {
    await sshExec(connectionId, `rm -f ${shQuote(tempPath)}`).catch(() => {});
  }
}


// --- Workflow helpers: repo snapshot, persistent checkpoint, verification ---

function getWorkflowAcl(connectionId, whitelist, blacklist) {
  const config = sshConfigs.get(connectionId) || {};
  return {
    whitelist: whitelist || config.whitelist || [],
    blacklist: blacklist || config.blacklist || []
  };
}

async function workflowExec(connectionId, command, whitelist, blacklist) {
  const acl = getWorkflowAcl(connectionId, whitelist, blacklist);
  const result = await sshExec(connectionId, command, acl.whitelist, acl.blacklist);
  if (result.exitCode !== 0) {
    throw new Error(truncateText(result.stderr || result.stdout || `command gagal dengan exit code ${result.exitCode}`, 8000));
  }
  return result.stdout || '';
}

async function sshRepoSnapshotWorkflow(connectionId, repoPath, fetch, whitelist, blacklist) {
  assertAbsolutePath(repoPath, 'repoPath');
  const output = await workflowExec(connectionId, buildRepoSnapshotCommand(repoPath, !!fetch), whitelist, blacklist);
  const parsed = parseTaggedOutput(output);
  return {
    repoPath,
    fetched: !!fetch,
    branch: parsed.branch || null,
    commit: parsed.commit || null,
    upstream: parsed.upstream || null,
    aheadBehind: parsed.ahead_behind || null,
    status: parsed.status || '',
    latest: parsed.latest || null,
    scripts: parsed.scripts ? parsed.scripts.split(',').filter(Boolean) : []
  };
}

async function getRemoteHome(connectionId, whitelist, blacklist) {
  const output = (await workflowExec(connectionId, 'printf \'%s\' "$HOME"', whitelist, blacklist)).trim();
  assertAbsolutePath(output, 'remote HOME');
  return output.replace(/\/+$/, '');
}

async function getCheckpointPaths(connectionId, checkpointId, whitelist, blacklist) {
  const home = await getRemoteHome(connectionId, whitelist, blacklist);
  const dir = `${home}/.mcp-workflow/checkpoints`;
  const file = checkpointId ? `${dir}/${assertCheckpointId(checkpointId)}.json` : null;
  return { dir, file };
}

async function loadCheckpointFile(connectionId, checkpointId, whitelist, blacklist) {
  const { file } = await getCheckpointPaths(connectionId, checkpointId, whitelist, blacklist);
  const q = workflowShellQuote(file);
  const output = await workflowExec(
    connectionId,
    `if [ ! -f ${q} ]; then echo 'checkpoint tidak ditemukan' >&2; exit 44; fi; cat -- ${q}`,
    whitelist,
    blacklist
  );
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('checkpoint rusak atau bukan JSON valid');
  }
}

async function sshCheckpointWorkflow(connectionId, action, checkpointId, data, whitelist, blacklist) {
  if (!['save', 'load', 'list', 'latest'].includes(action)) throw new Error('action checkpoint tidak valid');

  if (action === 'save') {
    const normalized = normalizeCheckpoint(checkpointId, data || {});
    const { dir, file } = await getCheckpointPaths(connectionId, checkpointId, whitelist, blacklist);
    await workflowExec(
      connectionId,
      `umask 077; mkdir -p -- ${workflowShellQuote(dir)}; chmod 700 -- ${workflowShellQuote(dir)}`,
      whitelist,
      blacklist
    );

    let snapshot = null;
    if (normalized.repoPath) {
      snapshot = await sshRepoSnapshotWorkflow(connectionId, normalized.repoPath, false, whitelist, blacklist);
      if (!normalized.branch && snapshot.branch) normalized.branch = snapshot.branch;
      if (!normalized.commit && snapshot.commit) normalized.commit = snapshot.commit;
    }

    const stored = {
      ...normalized,
      savedAt: new Date().toISOString(),
      ...(snapshot ? { repoStatus: truncateText(snapshot.status, 4000) } : {})
    };
    await sshWriteFile(connectionId, file, JSON.stringify(stored, null, 2) + '\n', 'utf8');
    await workflowExec(connectionId, `chmod 600 -- ${workflowShellQuote(file)}`, whitelist, blacklist);
    return stored;
  }

  if (action === 'load') {
    assertCheckpointId(checkpointId);
    return loadCheckpointFile(connectionId, checkpointId, whitelist, blacklist);
  }

  const { dir } = await getCheckpointPaths(connectionId, null, whitelist, blacklist);
  const qDir = workflowShellQuote(dir);
  const output = await workflowExec(
    connectionId,
    `if [ -d ${qDir} ]; then find ${qDir} -maxdepth 1 -type f -name '*.json' -printf '%T@ %f\\n' | sort -nr | head -50; fi`,
    whitelist,
    blacklist
  );
  const items = output.split(/\r?\n/).filter(Boolean).map(line => {
    const firstSpace = line.indexOf(' ');
    const stamp = firstSpace >= 0 ? Number(line.slice(0, firstSpace)) : NaN;
    const filename = firstSpace >= 0 ? line.slice(firstSpace + 1) : line;
    return {
      checkpointId: filename.replace(/\.json$/, ''),
      modifiedAt: Number.isFinite(stamp) ? new Date(stamp * 1000).toISOString() : null
    };
  });

  if (action === 'list') return { checkpoints: items };
  if (!items.length) return { checkpoint: null };
  return { checkpoint: await loadCheckpointFile(connectionId, items[0].checkpointId, whitelist, blacklist) };
}

async function sshRepoVerifyWorkflow(connectionId, repoPath, runScripts, whitelist, blacklist) {
  const acl = getWorkflowAcl(connectionId, whitelist, blacklist);
  const command = buildRepoVerifyCommand(repoPath, runScripts || []);
  const result = await sshExec(connectionId, command, acl.whitelist, acl.blacklist);
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    repoPath,
    runScripts: runScripts || [],
    output: truncateText(combined || '(tidak ada output)', 20000)
  };
}

async function sshRepoWorktreeWorkflow(connectionId, repoPath, action, args, whitelist, blacklist) {
  const command = buildRepoWorktreeCommand(repoPath, action, {
    worktreePath: args.worktreePath,
    branch: args.branch,
    baseRef: args.baseRef,
    fetch: args.fetch
  });
  const output = await workflowExec(connectionId, command, whitelist, blacklist);
  const parsed = parseTaggedOutput(output);
  return {
    ok: true,
    action,
    repoPath,
    ...(parsed.worktree ? { worktreePath: parsed.worktree } : {}),
    ...(parsed.removed ? { removed: parsed.removed } : {}),
    ...(parsed.branch ? { branch: parsed.branch } : {}),
    ...(parsed.commit ? { commit: parsed.commit } : {}),
    worktrees: truncateText(parsed.worktrees || output, 12000)
  };
}

async function sshRepoReviewWorkflow(connectionId, repoPath, baseRef, whitelist, blacklist) {
  const output = await workflowExec(connectionId, buildRepoReviewCommand(repoPath, baseRef || 'HEAD'), whitelist, blacklist);
  const parsed = parseTaggedOutput(output);
  return {
    repoPath,
    branch: parsed.branch || null,
    baseRef: parsed.base || baseRef || 'HEAD',
    status: parsed.status || '',
    diffCheck: parsed.diff_check || null,
    diffStat: parsed.diff_stat || '',
    changedFiles: parsed.changed_files || '',
    untracked: parsed.untracked || '',
    sensitiveFiles: parsed.sensitive_files || '',
    patch: truncateText(parsed.patch || '', 26000)
  };
}

async function sshRepoCommitPushWorkflow(connectionId, args) {
  const verification = await sshRepoVerifyWorkflow(
    connectionId,
    args.repoPath,
    args.runScripts || [],
    args.whitelist,
    args.blacklist
  );
  if (!verification.ok) {
    return {
      ok: false,
      stage: 'verify',
      committed: false,
      pushed: false,
      verification
    };
  }

  const commitOutput = await workflowExec(
    connectionId,
    buildRepoCommitCommand(args.repoPath, args.message, args.paths, !!args.allowProtectedBranch),
    args.whitelist,
    args.blacklist
  );
  const parsed = parseTaggedOutput(commitOutput);
  const result = {
    ok: true,
    stage: 'commit',
    committed: true,
    pushed: false,
    repoPath: args.repoPath,
    branch: parsed.branch || null,
    commit: parsed.commit || null,
    status: parsed.status || '',
    verification
  };

  if (!args.push) return result;

  try {
    const pushOutput = await workflowExec(
      connectionId,
      buildRepoPushCommand(args.repoPath, parsed.branch, args.remote || 'origin'),
      args.whitelist,
      args.blacklist
    );
    const pushParsed = parseTaggedOutput(pushOutput);
    return { ...result, stage: 'push', pushed: true, pushedTo: pushParsed.pushed || null };
  } catch (err) {
    return {
      ...result,
      ok: false,
      stage: 'push',
      pushed: false,
      pushError: truncateText(err.message, 4000)
    };
  }
}

const MAX_PROJECT_PROFILE_BYTES = 32 * 1024;

async function getProjectProfilePaths(connectionId, projectId, whitelist, blacklist) {
  const id = assertProjectId(projectId);
  const home = await getRemoteHome(connectionId, whitelist, blacklist);
  const dir = `${home}/.mcp-workflow/projects`;
  return { dir, file: `${dir}/${id}.json` };
}

async function readProjectProfile(connectionId, projectId, whitelist, blacklist) {
  const paths = await getProjectProfilePaths(connectionId, projectId, whitelist, blacklist);
  const output = await workflowExec(
    connectionId,
    `if [ ! -f ${workflowShellQuote(paths.file)} ]; then echo 'project profile tidak ditemukan' >&2; exit 48; fi; cat -- ${workflowShellQuote(paths.file)}`,
    whitelist,
    blacklist
  );
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw new Error('project profile JSON rusak'); }
  return { paths, profile: normalizeProjectProfile(parsed, { now: parsed.updatedAt || parsed.createdAt }) };
}

async function writeProjectProfile(connectionId, paths, profile, whitelist, blacklist) {
  const normalized = normalizeProjectProfile(profile, { now: profile.updatedAt || profile.createdAt });
  const serialized = JSON.stringify(normalized, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROJECT_PROFILE_BYTES) throw new Error('project profile terlalu besar');
  if (containsSecretLike(serialized)) throw new Error('project profile ditolak karena pola secret/credential');
  const temp = `${paths.file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  await workflowExec(
    connectionId,
    `umask 077; mkdir -p -- ${workflowShellQuote(paths.dir)}; chmod 700 -- ${workflowShellQuote(paths.dir)}`,
    whitelist,
    blacklist
  );
  try {
    await sshWriteFile(connectionId, temp, serialized, 'utf8');
    await workflowExec(
      connectionId,
      `chmod 600 -- ${workflowShellQuote(temp)}; mv -f -- ${workflowShellQuote(temp)} ${workflowShellQuote(paths.file)}; chmod 600 -- ${workflowShellQuote(paths.file)}`,
      whitelist,
      blacklist
    );
  } catch (err) {
    await workflowExec(connectionId, `rm -f -- ${workflowShellQuote(temp)}`, whitelist, blacklist).catch(() => {});
    throw err;
  }
  return normalized;
}

async function getProjectServiceStatus(connectionId, service, whitelist, blacklist) {
  try {
    const output = await workflowExec(
      connectionId,
      `systemctl show --no-pager -p LoadState -p ActiveState -p SubState -- ${workflowShellQuote(service)}`,
      whitelist,
      blacklist
    );
    const values = {};
    for (const line of output.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) values[line.slice(0, i)] = line.slice(i + 1);
    }
    return {
      service,
      ok: values.LoadState === 'loaded',
      loadState: values.LoadState || null,
      activeState: values.ActiveState || null,
      subState: values.SubState || null
    };
  } catch (err) {
    return { service, ok: false, error: truncateText(err.message, 1000) };
  }
}

async function sshProjectWorkflow(connectionId, action, args) {
  const allowed = ['list', 'create', 'update', 'show', 'status', 'verify', 'smoke'];
  if (!allowed.includes(action)) throw new Error('action project tidak valid');
  const whitelist = args.whitelist;
  const blacklist = args.blacklist;

  if (action === 'list') {
    const home = await getRemoteHome(connectionId, whitelist, blacklist);
    const dir = `${home}/.mcp-workflow/projects`;
    const output = await workflowExec(
      connectionId,
      `if [ -d ${workflowShellQuote(dir)} ]; then find ${workflowShellQuote(dir)} -maxdepth 1 -type f -name '*.json' -printf '%T@ %f\\n' | sort -nr | head -100; fi`,
      whitelist,
      blacklist
    );
    return {
      projects: output.split(/\r?\n/).filter(Boolean).map(line => {
        const firstSpace = line.indexOf(' ');
        const stamp = firstSpace >= 0 ? Number(line.slice(0, firstSpace)) : NaN;
        const file = firstSpace >= 0 ? line.slice(firstSpace + 1) : line;
        return {
          projectId: file.replace(/\.json$/, ''),
          modifiedAt: Number.isFinite(stamp) ? new Date(stamp * 1000).toISOString() : null
        };
      })
    };
  }

  if (action === 'create') {
    if (!args.profile) throw new Error('profile wajib untuk create');
    const profile = normalizeProjectProfile(args.profile);
    const paths = await getProjectProfilePaths(connectionId, profile.projectId, whitelist, blacklist);
    await workflowExec(
      connectionId,
      `if [ -e ${workflowShellQuote(paths.file)} ]; then echo 'project profile sudah ada' >&2; exit 49; fi`,
      whitelist,
      blacklist
    );
    const saved = await writeProjectProfile(connectionId, paths, profile, whitelist, blacklist);
    return { ok: true, action, profile: saved };
  }

  const projectId = assertProjectId(args.projectId);
  const { paths, profile } = await readProjectProfile(connectionId, projectId, whitelist, blacklist);

  if (action === 'update') {
    if (!args.patch) throw new Error('patch wajib untuk update');
    const updated = updateProjectProfile(profile, args.patch);
    const saved = await writeProjectProfile(connectionId, paths, updated, whitelist, blacklist);
    return { ok: true, action, profile: saved };
  }

  if (action === 'show') return { ok: true, action, profile };

  if (action === 'status') {
    const repo = await sshRepoSnapshotWorkflow(connectionId, profile.repoPath, args.fetch !== false, whitelist, blacklist);
    let handbook = null;
    if (profile.handbookPath) {
      try {
        handbook = await sshRepoSnapshotWorkflow(connectionId, profile.handbookPath, args.fetch !== false, whitelist, blacklist);
      } catch (err) {
        handbook = { ok: false, error: truncateText(err.message, 2000) };
      }
    }
    const services = [];
    for (const service of profile.services) {
      services.push(await getProjectServiceStatus(connectionId, service, whitelist, blacklist));
    }
    return { ok: true, action, profile, repo, handbook, services };
  }

  if (action === 'verify') {
    const verification = await sshRepoVerifyWorkflow(
      connectionId,
      profile.repoPath,
      args.runScripts || [],
      whitelist,
      blacklist
    );
    let handbook = null;
    if (profile.handbookPath) {
      try {
        const snap = await sshRepoSnapshotWorkflow(connectionId, profile.handbookPath, false, whitelist, blacklist);
        handbook = {
          ok: !String(snap.status || '').split(/\r?\n/).some(line => line && !line.startsWith('##')),
          snapshot: snap
        };
      } catch (err) {
        handbook = { ok: false, error: truncateText(err.message, 2000) };
      }
    }
    return {
      ok: verification.ok && (!handbook || handbook.ok),
      action,
      projectId,
      verification,
      handbook
    };
  }

  if (!profile.smokeUrls.length || !profile.browserHosts.length) {
    throw new Error('project profile belum memiliki browserHosts/smokeUrls');
  }
  const smokeUrl = args.url || profile.smokeUrls[0];
  if (!profile.smokeUrls.includes(smokeUrl)) throw new Error('url smoke harus terdaftar pada project profile');
  const result = await runBrowserSmoke({
    url: smokeUrl,
    expectedStatus: args.expectedStatus,
    expectedText: args.expectedText,
    expectedTitle: args.expectedTitle,
    timeoutMs: args.timeoutMs,
    screenshot: args.screenshot,
    maxScreenshotBytes: args.maxScreenshotBytes
  }, profile.browserHosts, BROWSER_SMOKE_LOCAL_PORTS);
  return { ok: result.ok, action, projectId, profile: { projectId, displayName: profile.displayName }, ...result };
}

async function getWorkspaceBase(connectionId, whitelist, blacklist) {
  const home = await getRemoteHome(connectionId, whitelist, blacklist);
  return `${home}/.mcp-workflow/workspaces`;
}

async function getWorkspacePaths(connectionId, workspaceId, whitelist, blacklist) {
  const id = assertWorkspaceId(workspaceId);
  const base = await getWorkspaceBase(connectionId, whitelist, blacklist);
  return {
    base,
    manifestDir: `${base}/manifests`,
    treeBase: `${base}/trees`,
    manifest: `${base}/manifests/${id}.json`,
    treeRoot: `${base}/trees/${id}`
  };
}

async function loadWorkspaceManifest(connectionId, workspaceId, whitelist, blacklist) {
  const paths = await getWorkspacePaths(connectionId, workspaceId, whitelist, blacklist);
  const output = await workflowExec(
    connectionId,
    `if [ ! -f ${workflowShellQuote(paths.manifest)} ]; then echo 'workspace tidak ditemukan' >&2; exit 44; fi; cat -- ${workflowShellQuote(paths.manifest)}`,
    whitelist,
    blacklist
  );
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw new Error('manifest workspace rusak'); }
  return { paths, manifest: normalizeWorkspaceManifest(workspaceId, parsed, paths.treeRoot) };
}

async function sshWorkspaceWorkflow(connectionId, action, args) {
  if (!['list', 'create', 'status', 'verify', 'remove'].includes(action)) {
    throw new Error('action workspace tidak valid');
  }
  const whitelist = args.whitelist;
  const blacklist = args.blacklist;

  if (action === 'list') {
    const base = await getWorkspaceBase(connectionId, whitelist, blacklist);
    const dir = `${base}/manifests`;
    const output = await workflowExec(
      connectionId,
      `if [ -d ${workflowShellQuote(dir)} ]; then find ${workflowShellQuote(dir)} -maxdepth 1 -type f -name '*.json' -printf '%T@ %f\\n' | sort -nr | head -50; fi`,
      whitelist,
      blacklist
    );
    return {
      workspaces: output.split(/\r?\n/).filter(Boolean).map(line => {
        const firstSpace = line.indexOf(' ');
        const stamp = firstSpace >= 0 ? Number(line.slice(0, firstSpace)) : NaN;
        const file = firstSpace >= 0 ? line.slice(firstSpace + 1) : line;
        return {
          workspaceId: file.replace(/\.json$/, ''),
          modifiedAt: Number.isFinite(stamp) ? new Date(stamp * 1000).toISOString() : null
        };
      })
    };
  }

  const workspaceId = assertWorkspaceId(args.workspaceId);

  if (action === 'create') {
    let projectId = null;
    let repoPath = args.repoPath;
    if (args.projectId) {
      projectId = assertProjectId(args.projectId);
      const { profile } = await readProjectProfile(connectionId, projectId, whitelist, blacklist);
      if (repoPath && repoPath !== profile.repoPath) throw new Error('repoPath tidak cocok dengan project profile');
      repoPath = profile.repoPath;
    }
    assertAbsolutePath(repoPath, 'repoPath');
    const tasks = normalizeWorkspaceTasks(args.tasks);
    const paths = await getWorkspacePaths(connectionId, workspaceId, whitelist, blacklist);
    await workflowExec(
      connectionId,
      `if [ -e ${workflowShellQuote(paths.manifest)} ] || [ -e ${workflowShellQuote(paths.treeRoot)} ]; then echo 'workspaceId sudah ada' >&2; exit 45; fi; umask 077; mkdir -p -- ${workflowShellQuote(paths.manifestDir)} ${workflowShellQuote(paths.treeRoot)}; chmod 700 -- ${workflowShellQuote(paths.base)} ${workflowShellQuote(paths.manifestDir)} ${workflowShellQuote(paths.treeBase)} ${workflowShellQuote(paths.treeRoot)} 2>/dev/null || true`,
      whitelist,
      blacklist
    );

    const created = [];
    let snapshot = null;
    try {
      snapshot = await sshRepoSnapshotWorkflow(connectionId, repoPath, args.fetch !== false, whitelist, blacklist);
      for (const task of tasks) {
        const worktreePath = `${paths.treeRoot}/${task.name}`;
        await workflowExec(
          connectionId,
          buildRepoWorktreeCommand(repoPath, 'create', {
            worktreePath,
            branch: task.branch,
            baseRef: task.baseRef,
            fetch: false
          }),
          whitelist,
          blacklist
        );
        created.push({ ...task, worktreePath });
      }

      const manifest = {
        workspaceId,
        projectId,
        repoPath,
        createdAt: new Date().toISOString(),
        baseCommit: snapshot.commit,
        tasks: created
      };
      await sshWriteFile(connectionId, paths.manifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      await workflowExec(connectionId, `chmod 600 -- ${workflowShellQuote(paths.manifest)}`, whitelist, blacklist);
      return { ok: true, action, ...manifest };
    } catch (err) {
      const rollbackErrors = [];
      for (const task of [...created].reverse()) {
        try {
          await workflowExec(
            connectionId,
            buildRepoWorktreeCommand(repoPath, 'remove', { worktreePath: task.worktreePath }),
            whitelist,
            blacklist
          );
          await workflowExec(
            connectionId,
            `cd ${workflowShellQuote(repoPath)} && git branch -D -- ${workflowShellQuote(task.branch)}`,
            whitelist,
            blacklist
          );
        } catch (rollbackErr) {
          rollbackErrors.push(task.name + ': ' + rollbackErr.message);
        }
      }
      await workflowExec(
        connectionId,
        `rm -f -- ${workflowShellQuote(paths.manifest)}; rmdir --ignore-fail-on-non-empty ${workflowShellQuote(paths.treeRoot)} ${workflowShellQuote(paths.treeBase)} ${workflowShellQuote(paths.manifestDir)} ${workflowShellQuote(paths.base)} 2>/dev/null || true`,
        whitelist,
        blacklist
      ).catch(() => {});
      const suffix = rollbackErrors.length ? '; rollback incomplete: ' + rollbackErrors.join(' | ') : '';
      throw new Error(err.message + suffix);
    }
  }

  const { paths, manifest } = await loadWorkspaceManifest(connectionId, workspaceId, whitelist, blacklist);

  if (action === 'status') {
    const tasks = [];
    for (const task of manifest.tasks) {
      try {
        const snapshot = await sshRepoSnapshotWorkflow(connectionId, task.worktreePath, false, whitelist, blacklist);
        const dirty = snapshot.status.split(/\r?\n/).some(line => line && !line.startsWith('##'));
        tasks.push({ ...task, ok: true, dirty, snapshot });
      } catch (err) {
        tasks.push({ ...task, ok: false, error: truncateText(err.message, 2000) });
      }
    }
    return { ok: tasks.every(t => t.ok), action, workspaceId, projectId: manifest.projectId || null, repoPath: manifest.repoPath, tasks };
  }

  if (action === 'verify') {
    const results = new Array(manifest.tasks.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= manifest.tasks.length) return;
        const task = manifest.tasks[index];
        try {
          const verification = await sshRepoVerifyWorkflow(
            connectionId,
            task.worktreePath,
            args.runScripts || [],
            whitelist,
            blacklist
          );
          results[index] = { ...task, ok: verification.ok, verification };
        } catch (err) {
          results[index] = { ...task, ok: false, error: truncateText(err.message, 3000) };
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(WORKSPACE_VERIFY_CONCURRENCY, manifest.tasks.length) },
      () => worker()
    ));
    return {
      ok: results.every(r => r.ok),
      action,
      workspaceId,
      projectId: manifest.projectId || null,
      repoPath: manifest.repoPath,
      concurrency: WORKSPACE_VERIFY_CONCURRENCY,
      tasks: results
    };
  }

  const status = await sshWorkspaceWorkflow(connectionId, 'status', { ...args, workspaceId });
  const dirty = status.tasks.filter(task => task.ok && task.dirty);
  const missing = status.tasks.filter(task => !task.ok);
  if (dirty.length || missing.length) {
    const details = [
      dirty.length ? 'dirty: ' + dirty.map(t => t.name).join(', ') : '',
      missing.length ? 'missing/error: ' + missing.map(t => t.name).join(', ') : ''
    ].filter(Boolean).join('; ');
    throw new Error('workspace remove ditolak; ' + details);
  }

  for (const task of [...manifest.tasks].reverse()) {
    await workflowExec(
      connectionId,
      buildRepoWorktreeCommand(manifest.repoPath, 'remove', { worktreePath: task.worktreePath }),
      whitelist,
      blacklist
    );
  }
  await workflowExec(
    connectionId,
    `rm -f -- ${workflowShellQuote(paths.manifest)}; rmdir --ignore-fail-on-non-empty ${workflowShellQuote(paths.treeRoot)} 2>/dev/null || true`,
    whitelist,
    blacklist
  );
  return { ok: true, action, workspaceId, removedTasks: manifest.tasks.map(t => t.name), branchesPreserved: true };
}

function agentBoardLockKey(connectionId, boardId) {
  const config = sshConfigs.get(connectionId);
  if (!config) throw new Error('Koneksi tidak ditemukan: ' + connectionId);
  return `${config.username || ''}@${config.host || ''}:${config.port || 22}:${assertAgentBoardId(boardId)}`;
}

async function withAgentBoardLock(connectionId, boardId, fn) {
  const key = agentBoardLockKey(connectionId, boardId);
  const previous = agentBoardLocks.get(key) || Promise.resolve();
  let release;
  const ticket = new Promise(resolveTicket => { release = resolveTicket; });
  const tail = previous.then(() => ticket);
  agentBoardLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (agentBoardLocks.get(key) === tail) agentBoardLocks.delete(key);
  }
}

async function getAgentBoardPaths(connectionId, boardId, whitelist, blacklist) {
  const id = assertAgentBoardId(boardId);
  const home = await getRemoteHome(connectionId, whitelist, blacklist);
  const dir = `${home}/.mcp-workflow/agent-boards`;
  return { dir, file: `${dir}/${id}.json` };
}

async function readAgentBoardState(connectionId, boardId, whitelist, blacklist) {
  const paths = await getAgentBoardPaths(connectionId, boardId, whitelist, blacklist);
  const output = await workflowExec(
    connectionId,
    `if [ ! -f ${workflowShellQuote(paths.file)} ]; then echo 'agent board tidak ditemukan' >&2; exit 46; fi; cat -- ${workflowShellQuote(paths.file)}`,
    whitelist,
    blacklist
  );
  let state;
  try { state = JSON.parse(output); } catch { throw new Error('agent board JSON rusak'); }
  return { paths, state: validateAgentBoardState(boardId, state) };
}

async function writeAgentBoardState(connectionId, paths, state, whitelist, blacklist) {
  validateAgentBoardState(state.boardId, state);
  const serialized = JSON.stringify(state, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AGENT_BOARD_BYTES) {
    throw new Error('agent board terlalu besar');
  }
  if (containsSecretLike(serialized)) {
    throw new Error('agent board ditolak karena terdeteksi pola secret/credential');
  }
  const temp = `${paths.file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  await workflowExec(
    connectionId,
    `umask 077; mkdir -p -- ${workflowShellQuote(paths.dir)}; chmod 700 -- ${workflowShellQuote(paths.dir)}`,
    whitelist,
    blacklist
  );
  try {
    await sshWriteFile(connectionId, temp, serialized, 'utf8');
    await workflowExec(
      connectionId,
      `chmod 600 -- ${workflowShellQuote(temp)}; mv -f -- ${workflowShellQuote(temp)} ${workflowShellQuote(paths.file)}; chmod 600 -- ${workflowShellQuote(paths.file)}`,
      whitelist,
      blacklist
    );
  } catch (err) {
    await workflowExec(connectionId, `rm -f -- ${workflowShellQuote(temp)}`, whitelist, blacklist).catch(() => {});
    throw err;
  }
}

function snapshotIsDirty(snapshot) {
  return String(snapshot.status || '').split(/\r?\n/).some(line => line && !line.startsWith('##'));
}

async function sshAgentBoardWorkflow(connectionId, action, args) {
  const allowed = ['list', 'create', 'status', 'claim', 'heartbeat', 'submit', 'release', 'remove'];
  if (!allowed.includes(action)) throw new Error('action agent board tidak valid');
  const whitelist = args.whitelist;
  const blacklist = args.blacklist;

  if (action === 'list') {
    const home = await getRemoteHome(connectionId, whitelist, blacklist);
    const dir = `${home}/.mcp-workflow/agent-boards`;
    const output = await workflowExec(
      connectionId,
      `if [ -d ${workflowShellQuote(dir)} ]; then find ${workflowShellQuote(dir)} -maxdepth 1 -type f -name '*.json' -printf '%T@ %f\\n' | sort -nr | head -50; fi`,
      whitelist,
      blacklist
    );
    return {
      boards: output.split(/\r?\n/).filter(Boolean).map(line => {
        const firstSpace = line.indexOf(' ');
        const stamp = firstSpace >= 0 ? Number(line.slice(0, firstSpace)) : NaN;
        const file = firstSpace >= 0 ? line.slice(firstSpace + 1) : line;
        return {
          boardId: file.replace(/\.json$/, ''),
          modifiedAt: Number.isFinite(stamp) ? new Date(stamp * 1000).toISOString() : null
        };
      })
    };
  }

  const boardId = assertAgentBoardId(args.boardId);
  return withAgentBoardLock(connectionId, boardId, async () => {
    if (action === 'create') {
      if (!args.workspaceId || !args.tasks) throw new Error('workspaceId dan tasks wajib untuk create');
      const { manifest } = await loadWorkspaceManifest(connectionId, args.workspaceId, whitelist, blacklist);
      const paths = await getAgentBoardPaths(connectionId, boardId, whitelist, blacklist);
      await workflowExec(
        connectionId,
        `if [ -e ${workflowShellQuote(paths.file)} ]; then echo 'agent board sudah ada' >&2; exit 47; fi`,
        whitelist,
        blacklist
      );
      const state = createAgentBoardState({
        boardId,
        workspaceId: args.workspaceId,
        workspaceManifest: manifest,
        tasks: args.tasks
      });
      await writeAgentBoardState(connectionId, paths, state, whitelist, blacklist);
      return { ok: true, action, board: summarizeAgentBoard(state) };
    }

    const { paths, state } = await readAgentBoardState(connectionId, boardId, whitelist, blacklist);
    const { manifest: currentWorkspace } = await loadWorkspaceManifest(
      connectionId,
      state.workspaceId,
      whitelist,
      blacklist
    );
    assertAgentBoardWorkspaceMapping(state, currentWorkspace);

    if (action === 'status') {
      if (expireAgentLeases(state)) await writeAgentBoardState(connectionId, paths, state, whitelist, blacklist);
      return { ok: true, action, board: summarizeAgentBoard(state) };
    }

    if (action === 'claim') {
      if (!args.agentId) throw new Error('agentId wajib untuk claim');
      const task = claimAgentTask(state, {
        agentId: args.agentId,
        taskName: args.taskName,
        leaseSeconds: args.leaseSeconds
      });
      const snapshot = await sshRepoSnapshotWorkflow(connectionId, task.worktreePath, false, whitelist, blacklist);
      if (snapshot.branch !== task.branch) throw new Error('branch worktree tidak cocok dengan agent board');
      if (snapshotIsDirty(snapshot)) throw new Error('worktree task tidak bersih; claim ditolak');
      await writeAgentBoardState(connectionId, paths, state, whitelist, blacklist);
      return { ok: true, action, task, snapshot, board: summarizeAgentBoard(state) };
    }

    if (action === 'heartbeat') {
      if (!args.agentId || !args.taskName) throw new Error('agentId dan taskName wajib untuk heartbeat');
      const task = heartbeatAgentTask(state, {
        agentId: args.agentId,
        taskName: args.taskName,
        leaseSeconds: args.leaseSeconds
      });
      await writeAgentBoardState(connectionId, paths, state, whitelist, blacklist);
      return { ok: true, action, task, board: summarizeAgentBoard(state) };
    }

    if (action === 'submit') {
      if (!args.agentId || !args.taskName || !args.summary) throw new Error('agentId, taskName, dan summary wajib untuk submit');
      const taskBefore = state.tasks.find(task => task.name === args.taskName);
      if (!taskBefore) throw new Error('task tidak ditemukan: ' + args.taskName);
      const snapshot = await sshRepoSnapshotWorkflow(connectionId, taskBefore.worktreePath, false, whitelist, blacklist);
      if (snapshot.branch !== taskBefore.branch) throw new Error('branch worktree tidak cocok dengan agent board');
      if (snapshotIsDirty(snapshot)) throw new Error('worktree task masih memiliki perubahan; commit/review sebelum submit');
      if (args.commit && !snapshot.commit.toLowerCase().startsWith(String(args.commit).toLowerCase())) {
        throw new Error('commit submit tidak cocok dengan HEAD worktree');
      }
      const task = submitAgentTask(state, {
        agentId: args.agentId,
        taskName: args.taskName,
        summary: args.summary,
        commit: snapshot.commit,
        evidence: args.evidence
      });
      await writeAgentBoardState(connectionId, paths, state, whitelist, blacklist);
      return { ok: true, action, task, snapshot, board: summarizeAgentBoard(state) };
    }

    if (action === 'release') {
      if (!args.agentId || !args.taskName) throw new Error('agentId dan taskName wajib untuk release');
      const task = releaseAgentTask(state, {
        agentId: args.agentId,
        taskName: args.taskName,
        note: args.note
      });
      await writeAgentBoardState(connectionId, paths, state, whitelist, blacklist);
      return { ok: true, action, task, board: summarizeAgentBoard(state) };
    }

    if (!canRemoveAgentBoard(state)) {
      throw new Error('agent board remove ditolak; semua task harus selesai dan tidak ada claim aktif');
    }
    await workflowExec(
      connectionId,
      `rm -f -- ${workflowShellQuote(paths.file)}; rmdir --ignore-fail-on-non-empty ${workflowShellQuote(paths.dir)} 2>/dev/null || true`,
      whitelist,
      blacklist
    );
    return { ok: true, action, boardId, removed: true };
  });
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
    { name: 'vps2-mcp', version: MCP_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: CHAT_WORKFLOW_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'browser_view',
        description: 'Tampilkan browser bersama VPS At-Tauhid sebagai panel interaktif di ChatGPT. Pengguna dapat memasukkan login langsung di panel.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
          type: 'object',
          properties: { ready: { type: 'boolean' } },
          required: ['ready'],
          additionalProperties: false
        },
        _meta: {
          ui: { resourceUri: BROWSER_UI_URI, visibility: ['model', 'app'] },
          'ui/resourceUri': BROWSER_UI_URI,
          'openai/outputTemplate': BROWSER_UI_URI,
          'openai/widgetAccessible': true,
          'openai/toolInvocation/invoking': 'Membuka browser VPS…',
          'openai/toolInvocation/invoked': 'Browser VPS siap'
        }
      },
      {
        name: 'browser_get_view_url',
        description: 'Ambil URL sesi browser sementara untuk panel MCP App. Tool ini hanya untuk dipanggil UI browser, bukan model.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            expiresAt: { type: 'number' }
          },
          required: ['url', 'expiresAt'],
          additionalProperties: false
        },
        _meta: {
          ui: { visibility: ['app'] },
          'openai/widgetAccessible': true
        }
      },
      {
        name: 'browser_set_mode',
        description: 'Ubah tampilan browser bersama antara desktop dan mobile. Mode mobile memakai emulasi viewport/touch browser sebenarnya, bukan sekadar memperkecil iframe.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['desktop','mobile'], description: 'Mode viewport browser' },
            width: { type: 'number', minimum: 320, maximum: 640, description: 'Lebar panel mobile (CSS px)' },
            height: { type: 'number', minimum: 320, maximum: 768, description: 'Tinggi panel mobile (CSS px)' },
            tabIndex: { type: 'number', description: 'Tab tujuan; default tab aktif' }
          },
          required: ['mode']
        },
        _meta: {
          ui: { visibility: ['model', 'app'] },
          'openai/widgetAccessible': true,
          'openai/toolInvocation/invoking': 'Mengubah mode browser…',
          'openai/toolInvocation/invoked': 'Mode browser diubah'
        }
      },
      {
        name: 'browser_open',
        description: 'Buka URL http/https pada Chromium bersama di VPS At-Tauhid. Browser memakai profil persisten yang juga dapat dilihat pengguna melalui noVNC.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL http/https yang akan dibuka' },
            tabIndex: { type: 'number', description: 'Tab tujuan; default tab aktif' },
            timeoutMs: { type: 'number', description: 'Timeout navigasi, default 15000 ms' },
            settleMs: { type: 'number', description: 'Jeda setelah navigasi sebelum hasil dikembalikan' }
          },
          required: ['url']
        }
      },
      {
        name: 'browser_snapshot',
        description: 'Baca kondisi halaman dan elemen interaktif dari browser bersama. Tidak mengembalikan nilai field input/password. Setiap elemen mendapat ref e0, e1, dst untuk click/type/select.',
        inputSchema: {
          type: 'object',
          properties: {
            tabIndex: { type: 'number', description: 'Tab yang dibaca; default tab aktif' },
            limit: { type: 'number', description: 'Batas elemen interaktif, default 120 maksimum 250' }
          }
        }
      },
      {
        name: 'browser_extract_text',
        description: 'Ambil teks halaman secara read-only dari DOM Chromium. Mendukung iframe, open Shadow DOM, auto-scroll opsional, dan pagination untuk halaman sangat panjang.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector target; default body' },
            tabIndex: { type: 'number' },
            includeFrames: { type: 'boolean', description: 'Sertakan iframe; default true' },
            includeShadowDom: { type: 'boolean', description: 'Sertakan open Shadow DOM; default true' },
            autoScroll: { type: 'boolean', description: 'Scroll halaman utama untuk memuat lazy content; default false' },
            maxScrollSteps: { type: 'number', minimum: 1, maximum: 60, description: 'Batas langkah auto-scroll; default 12' },
            offset: { type: 'number', minimum: 0, description: 'Posisi karakter awal untuk pagination; default 0' },
            maxChars: { type: 'number', minimum: 1000, maximum: 200000, description: 'Ukuran chunk; default/maksimum 200000 karakter' }
          }
        }
      },
      {
        name: 'browser_extract_transcript',
        description: 'Ambil caption/transkrip yang sudah tampil di DOM browser secara read-only. Tidak merekam audio. Mendukung iframe dan pagination.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Selector khusus transcript/caption; opsional. Jika kosong memakai selector caption/transcript umum.' },
            tabIndex: { type: 'number' },
            includeFrames: { type: 'boolean', description: 'Sertakan iframe; default true' },
            dedupe: { type: 'boolean', description: 'Hapus baris duplikat; default true' },
            offset: { type: 'number', minimum: 0, description: 'Posisi karakter awal untuk pagination; default 0' },
            maxChars: { type: 'number', minimum: 1000, maximum: 200000, description: 'Ukuran chunk; default/maksimum 200000 karakter' }
          }
        }
      },
      {
        name: 'browser_click',
        description: 'Klik elemen browser menggunakan ref dari browser_snapshot, CSS selector, atau teks.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Ref elemen, mis. e3' },
            selector: { type: 'string', description: 'CSS selector alternatif' },
            text: { type: 'string', description: 'Teks elemen alternatif' },
            exact: { type: 'boolean', description: 'Pencocokan text exact, default true' },
            tabIndex: { type: 'number' },
            timeoutMs: { type: 'number' },
            settleMs: { type: 'number' }
          }
        }
      },
      {
        name: 'browser_type',
        description: 'Isi field non-sensitif pada browser bersama. Tool menolak field password, OTP, token, PIN, 2FA/MFA, atau field yang terdeteksi sensitif; isi data sensitif langsung melalui noVNC.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            selector: { type: 'string' },
            text: { type: 'string', description: 'Teks elemen target, bukan nilai yang akan diketik' },
            exact: { type: 'boolean' },
            value: { type: 'string', description: 'Nilai non-sensitif yang akan diisi' },
            append: { type: 'boolean', description: 'Jika true, ketik di posisi saat ini; default false menggunakan fill' },
            delayMs: { type: 'number' },
            tabIndex: { type: 'number' }
          },
          required: ['value']
        }
      },
      {
        name: 'browser_select',
        description: 'Pilih opsi pada elemen select menggunakan ref/selector/text.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            selector: { type: 'string' },
            text: { type: 'string' },
            value: { type: 'string' },
            values: { type: 'array', items: { type: 'string' } },
            tabIndex: { type: 'number' }
          }
        }
      },
      {
        name: 'browser_wait',
        description: 'Tunggu waktu tertentu atau sampai selector/text/URL tertentu muncul.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            text: { type: 'string' },
            exact: { type: 'boolean' },
            urlContains: { type: 'string' },
            state: { type: 'string', enum: ['attached','detached','visible','hidden'] },
            timeoutMs: { type: 'number', description: 'Default 10000 ms, maksimum 60000 ms' },
            tabIndex: { type: 'number' }
          }
        }
      },
      {
        name: 'browser_screenshot',
        description: 'Ambil screenshot PNG dari tab browser aktif dan kembalikan sebagai image content.',
        inputSchema: {
          type: 'object',
          properties: {
            fullPage: { type: 'boolean', description: 'Screenshot seluruh halaman; default false' },
            tabIndex: { type: 'number' }
          }
        }
      },
      {
        name: 'browser_screenshot_view',
        description: 'Ambil screenshot PNG dari browser bersama VPS At-Tauhid dan tampilkan sebagai panel gambar MCP App. Gunakan saat client tidak menampilkan MCP image content secara langsung.',
        inputSchema: {
          type: 'object',
          properties: {
            fullPage: { type: 'boolean', description: 'Screenshot seluruh halaman; default false' },
            format: { type: 'string', enum: ['image','pdf'], description: 'Output panel: image PNG atau pdf; default image' },
            tabIndex: { type: 'number', description: 'Tab yang diambil; default tab aktif' }
          }
        },
        outputSchema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            format: { type: 'string', enum: ['image','pdf'] }
          },
          required: ['ready'],
          additionalProperties: false
        },
        _meta: {
          ui: { resourceUri: BROWSER_SCREENSHOT_UI_URI, visibility: ['model', 'app'] },
          'ui/resourceUri': BROWSER_SCREENSHOT_UI_URI,
          'openai/outputTemplate': BROWSER_SCREENSHOT_UI_URI,
          'openai/toolInvocation/invoking': 'Mengambil screenshot browser…',
          'openai/toolInvocation/invoked': 'Screenshot browser siap'
        }
      },
      {
        name: 'browser_execute_js',
        description: 'Jalankan JavaScript pada halaman Chromium aktif dan kembalikan hasilnya.',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'string' },
            tabIndex: { type: 'number' },
            timeoutMs: { type: 'number', description: 'Batas waktu eksekusi; default 10000 ms, maksimum 30000 ms' },
            offset: { type: 'number', minimum: 0, description: 'Posisi karakter awal untuk pagination; default 0' },
            maxChars: { type: 'number', minimum: 1000, maximum: 200000, description: 'Ukuran chunk per panggilan; default/maksimum 200000 karakter' }
          },
          required: ['script']
        }
      },
      {
        name: 'browser_tabs',
        description: 'Kelola tab browser: list, new, select, atau close.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list','new','select','close'], description: 'Default list' },
            index: { type: 'number', description: 'Index untuk select/close' },
            url: { type: 'string', description: 'URL opsional saat action=new' },
            timeoutMs: { type: 'number' }
          }
        }
      },
      {
        name: 'browser_back',
        description: 'Navigasi kembali pada tab browser aktif.',
        inputSchema: { type: 'object', properties: { tabIndex: { type: 'number' }, timeoutMs: { type: 'number' } } }
      },
      {
        name: 'browser_reload',
        description: 'Reload tab browser aktif.',
        inputSchema: { type: 'object', properties: { tabIndex: { type: 'number' }, timeoutMs: { type: 'number' } } }
      },
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
        name: 'ssh_create_upload_slot',
        description: 'PILIHAN WAJIB/UTAMA untuk transfer file binary dari Work/cloud workspace ke target SSH/project. Buat URL upload browser satu-kali pakai agar PNG/JPG/WebP/PDF/ZIP/APK dikirim sebagai binary langsung tanpa Base64/token bloat. JANGAN kirim binary lewat ssh_write_file encoding=base64 selama tool ini tersedia. Gunakan Base64 hanya sebagai fallback terakhir bila upload slot benar-benar tidak dapat digunakan.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            projectId: { type: 'string', description: 'Optional project profile; bila diisi, uploadRoots profile menjadi allowlist path' },
            remotePath: { type: 'string', description: 'Path tujuan final di server remote; dikunci ke slot ini' },
            maxBytes: { type: 'number', description: 'Batas ukuran file, default 20 MiB, maksimum 25 MiB' },
            expiresInSeconds: { type: 'number', description: 'Masa berlaku slot, default 600 detik; rentang 60..3600' },
            kind: { type: 'string', enum: ['image','pdf','zip','apk'], description: 'Jenis file; default image. Signature file akan diverifikasi.' },
            allowOverwrite: { type: 'boolean', description: 'Izinkan menimpa file existing; default false' }
          },
          required: ['connectionId', 'remotePath']
        }
      },
      {
        name: 'ssh_write_file',
        description: 'Tulis file teks UTF-8 baru (atau timpa) langsung di server remote dari string konten. Untuk file binary dari Work/cloud workspace, JANGAN gunakan encoding=base64 bila ssh_create_upload_slot tersedia; prioritaskan upload slot agar hemat token dan mendapat validasi keamanan. Base64 hanya fallback terakhir jika upload slot benar-benar tidak dapat digunakan.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            remotePath: { type: 'string', description: 'Path tujuan di server remote' },
            content: { type: 'string', description: 'Isi file yang akan ditulis' },
            encoding: { type: 'string', description: 'Encoding content: utf8 (default). base64 hanya fallback terakhir untuk binary jika ssh_create_upload_slot tidak dapat digunakan; jangan pilih base64 untuk binary Work selama upload slot tersedia.' }
          },
          required: ['connectionId', 'remotePath', 'content']
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
        name: 'ssh_read_image',
        description: 'Baca PNG/JPEG/WebP dari path remote yang diizinkan dan kembalikan sebagai MCP ImageContent agar model multimodal dapat melihat pixel. Magic bytes, realpath, allowlist direktori, dan batas ukuran diverifikasi; bukan pembaca file umum.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            projectId: { type: 'string', description: 'Optional project profile; bila diisi, imageRoots profile menjadi allowlist path' },
            remotePath: { type: 'string', description: 'Path absolut PNG/JPEG/WebP pada direktori gambar yang diizinkan' },
            maxBytes: { type: 'number', description: 'Batas ukuran gambar, default 5 MiB dan maksimum 10 MiB' }
          },
          required: ['connectionId', 'remotePath']
        }
      },
      {
        name: 'adb_screenshot_visual',
        description: 'Ambil screenshot perangkat Android yang sudah terhubung melalui reverse ADB loopback lalu kembalikan sebagai MCP ImageContent. Gunakan hanya untuk perangkat/pengujian yang diotorisasi pengguna; tool tidak memberi akses live video dan deviceId wajib eksplisit.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            deviceId: { type: 'string', description: 'Serial ADB perangkat yang sudah diotorisasi, mis. RR8RB0B7F3A' },
            maxBytes: { type: 'number', description: 'Batas ukuran screenshot, default 5 MiB dan maksimum 10 MiB' }
          },
          required: ['connectionId', 'deviceId']
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
        name: 'ssh_repo_snapshot',
        description: 'Ambil snapshot Git terstruktur untuk bootstrap/restore pekerjaan: branch, commit, upstream, ahead/behind, working tree, commit terbaru, dan scripts package.json. Opsi fetch=true menjalankan git fetch --all --prune tanpa checkout/reset/merge.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            repoPath: { type: 'string', description: 'Path absolut repository Git di target SSH' },
            fetch: { type: 'boolean', description: 'Jika true, jalankan git fetch --all --prune terlebih dahulu; default false' },
            whitelist: { type: 'array', items: { type: 'string' }, description: 'Override whitelist regex, opsional' },
            blacklist: { type: 'array', items: { type: 'string' }, description: 'Override blacklist regex, opsional' }
          },
          required: ['connectionId', 'repoPath']
        }
      },
      {
        name: 'ssh_checkpoint',
        description: 'Saat melanjutkan pekerjaan, pilih checkpoint yang sesuai tujuan/project; latest bisa milik tugas lain. Bandingkan dengan snapshot Git aktual. Simpan setelah milestone dan sebelum mengakhiri sesi. Simpan/pulihkan checkpoint kerja non-secret di target SSH (~/.mcp-workflow/checkpoints) agar sesi Chat berikutnya dapat melanjutkan pekerjaan. Jangan masukkan password, token, API key, private key, .env, atau credential; pola secret umum ditolak saat save.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            action: { type: 'string', enum: ['save','load','list','latest'], description: 'save/load/list/latest' },
            checkpointId: { type: 'string', description: 'ID checkpoint; wajib untuk save/load' },
            data: {
              type: 'object',
              description: 'Metadata operasional non-secret untuk action=save',
              properties: {
                objective: { type: 'string' },
                phase: { type: 'string', enum: ['plan','implement','review','verify','blocked','done'] },
                project: { type: 'string' },
                repoPath: { type: 'string' },
                branch: { type: 'string' },
                commit: { type: 'string' },
                completed: { type: 'array', items: { type: 'string' } },
                next: { type: 'array', items: { type: 'string' } },
                artifacts: { type: 'array', items: { type: 'string' } },
                notes: { type: 'string' }
              },
              additionalProperties: false
            },
            whitelist: { type: 'array', items: { type: 'string' }, description: 'Override whitelist regex, opsional' },
            blacklist: { type: 'array', items: { type: 'string' }, description: 'Override blacklist regex, opsional' }
          },
          required: ['connectionId', 'action']
        }
      },
      {
        name: 'ssh_repo_verify',
        description: 'Jalankan verification loop terkontrol pada repo: git diff --check, status/diff stat, dan secret-like scan pada perubahan. runScripts opsional hanya mengizinkan typecheck/lint/test/build dan menjalankan script package.json repo; gunakan setelah source repo dipercaya/reviewed.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            repoPath: { type: 'string', description: 'Path absolut repository Git' },
            runScripts: { type: 'array', items: { type: 'string', enum: ['typecheck','lint','test','build'] }, description: 'Script package.json yang ingin dijalankan; default kosong' },
            whitelist: { type: 'array', items: { type: 'string' }, description: 'Override whitelist regex, opsional' },
            blacklist: { type: 'array', items: { type: 'string' }, description: 'Override blacklist regex, opsional' }
          },
          required: ['connectionId', 'repoPath']
        }
      },
      {
        name: 'ssh_repo_worktree',
        description: 'Kelola isolated Git worktree untuk development aman. create selalu membuat branch lokal baru; remove hanya menghapus worktree yang bersih dan tidak menghapus branch; list menampilkan worktree aktual.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            repoPath: { type: 'string', description: 'Path absolut repository Git utama' },
            action: { type: 'string', enum: ['list','create','remove'] },
            worktreePath: { type: 'string', description: 'Path absolut worktree; wajib untuk create/remove' },
            branch: { type: 'string', description: 'Branch baru; wajib untuk create' },
            baseRef: { type: 'string', description: 'Base ref create, default HEAD' },
            fetch: { type: 'boolean', description: 'Fetch --all --prune sebelum create; default false' },
            whitelist: { type: 'array', items: { type: 'string' } },
            blacklist: { type: 'array', items: { type: 'string' } }
          },
          required: ['connectionId','repoPath','action']
        }
      },
      {
        name: 'ssh_repo_review',
        description: 'Review perubahan Git terstruktur terhadap baseRef tanpa membaca .env/credential. Menampilkan status, diff check/stat, file berubah, untracked, dan patch terbatas; patch dihilangkan bila path sensitif terdeteksi.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            repoPath: { type: 'string', description: 'Path absolut repository/worktree Git' },
            baseRef: { type: 'string', description: 'Git ref pembanding, default HEAD' },
            whitelist: { type: 'array', items: { type: 'string' } },
            blacklist: { type: 'array', items: { type: 'string' } }
          },
          required: ['connectionId','repoPath']
        }
      },
      {
        name: 'ssh_repo_commit_push',
        description: 'Verifikasi lalu commit path eksplisit secara aman; menolak pre-existing staged changes, path sensitif, secret-like diff, detached HEAD, dan protected branch secara default. Push hanya jika push=true; kegagalan push dilaporkan tanpa menyembunyikan commit lokal yang sudah berhasil.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            repoPath: { type: 'string', description: 'Path absolut repository/worktree Git' },
            message: { type: 'string', description: 'Commit message satu baris' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Path relatif repo yang akan di-stage secara eksplisit' },
            runScripts: { type: 'array', items: { type: 'string', enum: ['typecheck','lint','test','build'] }, description: 'Verification scripts sebelum staging/commit' },
            push: { type: 'boolean', description: 'Jika true, push commit setelah commit sukses; default false' },
            remote: { type: 'string', description: 'Remote push, default origin' },
            allowProtectedBranch: { type: 'boolean', description: 'Harus true secara eksplisit untuk commit ke main/master/production/prod' },
            whitelist: { type: 'array', items: { type: 'string' } },
            blacklist: { type: 'array', items: { type: 'string' } }
          },
          required: ['connectionId','repoPath','message','paths']
        }
      },
      {
        name: 'ssh_project',
        description: 'Registry project portable pada target SSH. Profile non-secret menyimpan repo, handbook, browser hosts/smoke URLs, service, dan allowed roots. Mendukung list/create/update/show/status/verify/smoke. Tidak menjalankan deploy otomatis.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            action: { type: 'string', enum: ['list','create','update','show','status','verify','smoke'] },
            projectId: { type: 'string', description: 'Lowercase project slug; wajib kecuali list/create' },
            profile: {
              type: 'object',
              description: 'Profile non-secret untuk create',
              properties: {
                projectId: { type: 'string' },
                displayName: { type: 'string' },
                repoPath: { type: 'string' },
                handbookPath: { type: ['string','null'] },
                browserHosts: { type: 'array', items: { type: 'string' }, maxItems: 30 },
                smokeUrls: { type: 'array', items: { type: 'string' }, maxItems: 10 },
                services: { type: 'array', items: { type: 'string' }, maxItems: 12 },
                uploadRoots: { type: 'array', items: { type: 'string' }, maxItems: 20 },
                imageRoots: { type: 'array', items: { type: 'string' }, maxItems: 20 }
              },
              required: ['projectId','repoPath'],
              additionalProperties: false
            },
            patch: { type: 'object', description: 'Partial profile untuk update; projectId/createdAt tidak boleh diubah' },
            fetch: { type: 'boolean', description: 'Fetch repo/handbook saat status; default true' },
            runScripts: { type: 'array', items: { type: 'string', enum: ['typecheck','lint','test','build'] } },
            url: { type: 'string', description: 'Untuk smoke; harus salah satu smokeUrls profile' },
            expectedStatus: {
              oneOf: [
                { type: 'integer', minimum: 100, maximum: 599 },
                { type: 'array', minItems: 1, maxItems: 10, items: { type: 'integer', minimum: 100, maximum: 599 } }
              ]
            },
            expectedText: { type: 'string' },
            expectedTitle: { type: 'string' },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 },
            screenshot: { type: 'boolean' },
            maxScreenshotBytes: { type: 'integer', minimum: 1024, maximum: 10485760 },
            whitelist: { type: 'array', items: { type: 'string' } },
            blacklist: { type: 'array', items: { type: 'string' } }
          },
          required: ['connectionId','action'],
          additionalProperties: false
        }
      },
      {
        name: 'browser_smoke',
        description: 'Render smoke test web dengan Playwright Chromium headless pada domain allowlist. Tidak melakukan login/form action dan memblokir request keluar allowlist. Dapat memeriksa status/text/title serta mengembalikan screenshot viewport.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL yang akan dirender; wajib berada pada allowlist browser' },
            expectedStatus: {
              oneOf: [
                { type: 'integer', minimum: 100, maximum: 599 },
                { type: 'array', minItems: 1, maxItems: 10, items: { type: 'integer', minimum: 100, maximum: 599 } }
              ]
            },
            expectedText: { type: 'string', description: 'Teks yang harus terlihat pada body, opsional' },
            expectedTitle: { type: 'string', description: 'Substring title yang harus cocok, opsional' },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 },
            screenshot: { type: 'boolean', description: 'Kembalikan screenshot viewport; default true' },
            maxScreenshotBytes: { type: 'integer', minimum: 1024, maximum: 10485760 }
          },
          required: ['url']
        }
      },
      {
        name: 'ssh_workspace',
        description: 'Orkestrasi workspace multi-worktree terkontrol untuk beberapa task paralel pada satu repo. create membuat 1-6 branch/worktree dan manifest non-secret; status memeriksa semua task; verify menjalankan verification loop pada semua task; remove hanya jika semua worktree bersih; list menampilkan workspace tersimpan.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            action: { type: 'string', enum: ['list','create','status','verify','remove'] },
            workspaceId: { type: 'string', description: 'ID workspace; wajib kecuali list' },
            projectId: { type: 'string', description: 'Optional project profile; bila diisi, repoPath diambil dari profile dan repoPath mismatch ditolak' },
            repoPath: { type: 'string', description: 'Path repo utama; wajib untuk create jika projectId tidak diisi' },
            tasks: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  branch: { type: 'string' },
                  baseRef: { type: 'string', description: 'Default HEAD' }
                },
                required: ['name','branch'],
                additionalProperties: false
              }
            },
            fetch: { type: 'boolean', description: 'Untuk create, fetch --all --prune sebelum membuat task; default true' },
            runScripts: { type: 'array', items: { type: 'string', enum: ['typecheck','lint','test','build'] }, description: 'Untuk verify' },
            whitelist: { type: 'array', items: { type: 'string' } },
            blacklist: { type: 'array', items: { type: 'string' } }
          },
          required: ['connectionId','action']
        }
      },
      {
        name: 'ssh_agent_board',
        description: 'Koordinasi multi-session agent pada workspace Git tanpa menjalankan model LLM di VPS. create memetakan task workspace ke role/objective/dependency; claim memakai lease eksklusif; heartbeat memperpanjang lease; submit hanya menerima worktree bersih dan merekam HEAD aktual; release mengembalikan task ke antrean; remove hanya setelah semua task selesai. Tool ini tidak auto-merge, auto-deploy, atau auto-spawn model.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID koneksi SSH' },
            action: { type: 'string', enum: ['list','create','status','claim','heartbeat','submit','release','remove'] },
            boardId: { type: 'string', description: 'ID agent board; wajib kecuali list' },
            workspaceId: { type: 'string', description: 'Workspace existing; wajib untuk create' },
            tasks: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Harus sama dengan task name pada workspace' },
                  role: { type: 'string', description: 'Role agent, default implementer' },
                  objective: { type: 'string', description: 'Instruksi non-secret task' },
                  dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 5 }
                },
                required: ['name','objective'],
                additionalProperties: false
              }
            },
            agentId: { type: 'string', description: 'ID unik sesi/agent untuk claim ownership' },
            taskName: { type: 'string', description: 'Task target; claim boleh kosong untuk mengambil task ready pertama' },
            leaseSeconds: { type: 'integer', minimum: 60, maximum: 3600, description: 'Lease claim/heartbeat, default 900 detik' },
            summary: { type: 'string', description: 'Ringkasan non-secret hasil task; wajib untuk submit' },
            commit: { type: 'string', description: 'Optional expected commit/prefix; submit memverifikasi terhadap HEAD aktual' },
            evidence: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Bukti verifikasi non-secret' },
            note: { type: 'string', description: 'Catatan non-secret saat release' },
            whitelist: { type: 'array', items: { type: 'string' } },
            blacklist: { type: 'array', items: { type: 'string' } }
          },
          required: ['connectionId','action'],
          additionalProperties: false
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

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: BROWSER_UI_URI,
        name: 'Browser VPS At-Tauhid',
        mimeType: 'text/html;profile=mcp-app',
        _meta: {
          'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
          ui: {
            ...(/claude/i.test(server.getClientVersion()?.name || '') ? { domain: claudeAppDomain(BASE_URL) } : {}),
            prefersBorder: false,
            csp: {
              connectDomains: [],
              resourceDomains: [],
              frameDomains: ['https://browser-vps.hijrah-attauhid.or.id']
            }
          }
        }
      },
      {
        uri: BROWSER_SCREENSHOT_UI_URI,
        name: 'Screenshot Browser VPS At-Tauhid',
        mimeType: 'text/html;profile=mcp-app',
        _meta: {
          'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
          ui: {
            ...(/claude/i.test(server.getClientVersion()?.name || '') ? { domain: claudeAppDomain(BASE_URL) } : {}),
            prefersBorder: false
          }
        }
      }
    ]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const requestedUri = request.params.uri;
    if (requestedUri === BROWSER_SCREENSHOT_UI_URI) {
      console.error('[UI] resources/read', requestedUri);
      return { contents: [{
        uri: requestedUri,
        mimeType: 'text/html;profile=mcp-app',
        text: readFileSync(resolve(__dirname, 'browser-screenshot-ui.html'), 'utf8'),
        _meta: {
          ui: {
            ...(/claude/i.test(server.getClientVersion()?.name || '') ? { domain: claudeAppDomain(BASE_URL) } : {}),
            prefersBorder: false
          },
          'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
          'openai/widgetDescription': 'Screenshot statis dari browser bersama VPS At-Tauhid.',
          'openai/widgetPrefersBorder': false
        }
      }] };
    }
    if (!BROWSER_UI_URI_RE.test(requestedUri)) throw new Error('Resource tidak ditemukan');
    console.error('[UI] resources/read', requestedUri);
    return { contents: [{
      uri: requestedUri,
      mimeType: 'text/html;profile=mcp-app',
      text: readFileSync(resolve(__dirname, 'browser-ui.html'), 'utf8').replace('__BROWSER_VIEW_URL__', browserViewLink()),
      _meta: {
        ui: {
          ...(/claude/i.test(server.getClientVersion()?.name || '') ? { domain: claudeAppDomain(BASE_URL) } : {}),
          prefersBorder: false,
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: ['https://browser-vps.hijrah-attauhid.or.id']
          }
        },
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
        'openai/widgetDescription': 'Browser bersama VPS At-Tauhid yang dapat dikendalikan langsung dari ChatGPT.',
        'openai/widgetPrefersBorder': false,
        'openai/widgetCSP': {
          connect_domains: [],
          resource_domains: [],
          frame_domains: ['https://browser-vps.hijrah-attauhid.or.id']
        }
      }
    }] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'browser_view') {
      const viewLink = browserViewLink();
      console.error('[UI] browser_view invoked');
      return {
        structuredContent: { ready: true },
        content: [{ type: 'text', text: 'Browser VPS At-Tauhid siap ditampilkan pada panel interaktif.' }],
        _meta: {
          browserViewUrl: viewLink,
          ui: { resourceUri: BROWSER_UI_URI },
          'openai/outputTemplate': BROWSER_UI_URI
        }
      };
    }

    if (name === 'browser_get_view_url') {
      try {
        const url = browserViewLink();
        const expiresAt = Number(new URL(url).searchParams.get('expires'));
        return {
          structuredContent: { url, expiresAt },
          content: [{ type: 'text', text: 'URL sesi browser siap untuk panel.' }]
        };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser View URL Error: ' + err.message }], isError: true };
      }
    }

    if (name === 'browser_set_mode') {
      try {
        const result = await browserSetMode(args || {});
        return {
          structuredContent: { mode: result.mode, viewport: result.viewport },
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Set Mode Error: ' + err.message }], isError: true };
      }
    }

    if (name === 'browser_open') {
      try {
        const result = await browserOpen(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Open Error: ' + err.message }] };
      }
    }

    if (name === 'browser_snapshot') {
      try {
        const result = await browserSnapshot(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Snapshot Error: ' + err.message }] };
      }
    }

    if (name === 'browser_extract_text') {
      try {
        const result = await browserExtractText(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Extract Text Error: ' + err.message }], isError: true };
      }
    }

    if (name === 'browser_extract_transcript') {
      try {
        const result = await browserExtractTranscript(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Extract Transcript Error: ' + err.message }], isError: true };
      }
    }

    if (name === 'browser_click') {
      try {
        const result = await browserClick(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Click Error: ' + err.message }] };
      }
    }

    if (name === 'browser_type') {
      try {
        const result = await browserType(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Type Error: ' + err.message }] };
      }
    }

    if (name === 'browser_select') {
      try {
        const result = await browserSelect(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Select Error: ' + err.message }] };
      }
    }

    if (name === 'browser_wait') {
      try {
        const result = await browserWait(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Wait Error: ' + err.message }] };
      }
    }

    if (name === 'browser_screenshot') {
      try {
        const result = await browserScreenshot(args || {});
        return { content: [
          { type: 'text', text: JSON.stringify(result.info, null, 2) },
          { type: 'image', data: result.image, mimeType: 'image/png' }
        ] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Screenshot Error: ' + err.message }] };
      }
    }

    if (name === 'browser_screenshot_view') {
      try {
        if ((args || {}).format === 'pdf') {
          const result = await browserExportPdf(args || {});
          return {
            structuredContent: { ready: true, format: 'pdf' },
            content: [{ type: 'text', text: 'PDF browser siap ditampilkan pada panel.' }],
            _meta: {
              pdfData: result.pdf,
              pdfInfo: result.info,
              ui: { resourceUri: BROWSER_SCREENSHOT_UI_URI },
              'openai/outputTemplate': BROWSER_SCREENSHOT_UI_URI
            }
          };
        }
        const result = await browserScreenshot(args || {});
        return {
          structuredContent: { ready: true, format: 'image' },
          content: [{ type: 'text', text: 'Screenshot browser siap ditampilkan pada panel gambar.' }],
          _meta: {
            screenshotDataUrl: 'data:image/png;base64,' + result.image,
            screenshotInfo: result.info,
            ui: { resourceUri: BROWSER_SCREENSHOT_UI_URI },
            'openai/outputTemplate': BROWSER_SCREENSHOT_UI_URI
          }
        };
      } catch (err) {
        return {
          structuredContent: { ready: false },
          content: [{ type: 'text', text: 'Browser Screenshot View Error: ' + err.message }],
          isError: true
        };
      }
    }

    if (name === 'browser_execute_js') {
      try {
        const result = await browserExecuteJs(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Execute JS Error: ' + err.message }], isError: true };
      }
    }

    if (name === 'browser_tabs') {
      try {
        const result = await browserTabs(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Tabs Error: ' + err.message }] };
      }
    }

    if (name === 'browser_back') {
      try {
        const result = await browserBack(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Back Error: ' + err.message }] };
      }
    }

    if (name === 'browser_reload') {
      try {
        const result = await browserReload(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Reload Error: ' + err.message }] };
      }
    }

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

    if (name === 'ssh_create_upload_slot') {
      try {
        let allowedRoots = UPLOAD_ALLOWED_ROOTS;
        if (args.projectId) {
          const { profile } = await readProjectProfile(args.connectionId, args.projectId);
          if (!profile.uploadRoots.length) throw new Error('project profile belum memiliki uploadRoots');
          allowedRoots = profile.uploadRoots;
        }
        const result = createUploadSlot(
          args.connectionId,
          args.remotePath,
          args.maxBytes,
          args.expiresInSeconds,
          args.kind || 'image',
          args.allowOverwrite || false,
          allowedRoots
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Create Upload Slot Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_write_file') {
      try {
        const result = await sshWriteFile(args.connectionId, args.remotePath, args.content, args.encoding);
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Write File Error: ' + err.message }] };
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

    if (name === 'ssh_read_image') {
      try {
        let allowedRoots = IMAGE_READ_ALLOWED_ROOTS;
        if (args.projectId) {
          const { profile } = await readProjectProfile(args.connectionId, args.projectId);
          if (!profile.imageRoots.length) throw new Error('project profile belum memiliki imageRoots');
          allowedRoots = profile.imageRoots;
        }
        const result = await sshReadImageBuffer(args.connectionId, args.remotePath, args.maxBytes, allowedRoots);
        return {
          content: [
            { type: 'text', text: `Image siap: ${result.realPath} (${result.size} bytes, ${result.mimeType})` },
            toImageContent(result.buffer, result.mimeType)
          ]
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Read Image Error: ' + err.message }] };
      }
    }

    if (name === 'adb_screenshot_visual') {
      try {
        const result = await adbScreenshotVisual(args.connectionId, args.deviceId, args.maxBytes);
        return {
          content: [
            { type: 'text', text: `Screenshot ADB ${args.deviceId} (${result.size} bytes, ${result.mimeType})` },
            toImageContent(result.buffer, result.mimeType)
          ]
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'ADB Screenshot Error: ' + err.message }] };
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

    if (name === 'ssh_repo_snapshot') {
      try {
        const result = await sshRepoSnapshotWorkflow(args.connectionId, args.repoPath, args.fetch, args.whitelist, args.blacklist);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Repo Snapshot Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_checkpoint') {
      try {
        if ((args.action === 'save' || args.action === 'load') && !args.checkpointId) {
          throw new Error('checkpointId wajib untuk action=' + args.action);
        }
        const result = await sshCheckpointWorkflow(args.connectionId, args.action, args.checkpointId, args.data, args.whitelist, args.blacklist);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Checkpoint Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_repo_verify') {
      try {
        const result = await sshRepoVerifyWorkflow(args.connectionId, args.repoPath, args.runScripts, args.whitelist, args.blacklist);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Repo Verify Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_repo_worktree') {
      try {
        if ((args.action === 'create' || args.action === 'remove') && !args.worktreePath) {
          throw new Error('worktreePath wajib untuk action=' + args.action);
        }
        if (args.action === 'create' && !args.branch) throw new Error('branch wajib untuk action=create');
        const result = await sshRepoWorktreeWorkflow(args.connectionId, args.repoPath, args.action, args, args.whitelist, args.blacklist);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Repo Worktree Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_repo_review') {
      try {
        const result = await sshRepoReviewWorkflow(args.connectionId, args.repoPath, args.baseRef, args.whitelist, args.blacklist);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Repo Review Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_repo_commit_push') {
      try {
        const result = await sshRepoCommitPushWorkflow(args.connectionId, args);
        return {
          ...(result.ok ? {} : { isError: true }),
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Repo Commit/Push Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_project') {
      if (args.action === 'smoke') {
        if (browserSmokeActive >= MAX_BROWSER_SMOKE_CONCURRENCY) {
          return { isError: true, content: [{ type: 'text', text: 'Project Smoke Error: browser smoke lain masih aktif' }] };
        }
        browserSmokeActive++;
        try {
          if (!args.projectId) throw new Error('projectId wajib untuk action=smoke');
          const result = await sshProjectWorkflow(args.connectionId, args.action, args);
          const screenshot = result.screenshot;
          const safeResult = { ...result, screenshot: screenshot ? { bytes: screenshot.length, mimeType: 'image/png' } : null };
          const content = [{ type: 'text', text: JSON.stringify(safeResult, null, 2) }];
          if (screenshot) {
            assertImageBuffer(screenshot, args.maxScreenshotBytes);
            content.push(toImageContent(screenshot, 'image/png'));
          }
          return { ...(result.ok ? {} : { isError: true }), content };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: 'Project Smoke Error: ' + err.message }] };
        } finally {
          browserSmokeActive--;
        }
      }
      try {
        if (!['list','create'].includes(args.action) && !args.projectId) throw new Error('projectId wajib untuk action=' + args.action);
        const result = await sshProjectWorkflow(args.connectionId, args.action, args);
        return {
          ...(result.ok === false ? { isError: true } : {}),
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Project Error: ' + err.message }] };
      }
    }

    if (name === 'browser_smoke') {
      if (browserSmokeActive >= MAX_BROWSER_SMOKE_CONCURRENCY) {
        return { isError: true, content: [{ type: 'text', text: 'Browser Smoke Error: browser smoke lain masih aktif' }] };
      }
      browserSmokeActive++;
      try {
        const result = await runBrowserSmoke(args, BROWSER_SMOKE_ALLOWED_HOSTS, BROWSER_SMOKE_LOCAL_PORTS);
        const screenshot = result.screenshot;
        const safeResult = { ...result, screenshot: screenshot ? { bytes: screenshot.length, mimeType: 'image/png' } : null };
        const content = [{ type: 'text', text: JSON.stringify(safeResult, null, 2) }];
        if (screenshot) {
          assertImageBuffer(screenshot, args.maxScreenshotBytes);
          content.push(toImageContent(screenshot, 'image/png'));
        }
        return { ...(result.ok ? {} : { isError: true }), content };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Browser Smoke Error: ' + err.message }] };
      } finally {
        browserSmokeActive--;
      }
    }

    if (name === 'ssh_workspace') {
      try {
        if (args.action !== 'list' && !args.workspaceId) throw new Error('workspaceId wajib untuk action=' + args.action);
        if (args.action === 'create' && (!args.tasks || (!args.projectId && !args.repoPath))) throw new Error('tasks dan projectId atau repoPath wajib untuk action=create');
        const result = await sshWorkspaceWorkflow(args.connectionId, args.action, args);
        return {
          ...(result.ok === false ? { isError: true } : {}),
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Workspace Error: ' + err.message }] };
      }
    }

    if (name === 'ssh_agent_board') {
      try {
        if (args.action !== 'list' && !args.boardId) throw new Error('boardId wajib untuk action=' + args.action);
        const result = await sshAgentBoardWorkflow(args.connectionId, args.action, args);
        return {
          ...(result.ok === false ? { isError: true } : {}),
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: 'Agent Board Error: ' + err.message }] };
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
  const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
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
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f4f8ff"><title>MCP VPS2 - Izinkan Akses</title>
<style>
:root{color-scheme:light;--navy:#10224a;--text:#1e293b;--muted:#64748b;--line:#dbe5f1;--blue:#1769e8;--blue2:#0f5bd8;--soft:#edf5ff;--danger:#dc2626;--danger-soft:#fff1f2}
*{box-sizing:border-box}
html{background:#f4f7fb}
body{margin:0;min-height:100vh;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(180deg,#edf5ff 0,#f7faff 24%,#f4f7fb 100%);color:var(--text);-webkit-font-smoothing:antialiased}
.page{width:min(100%,720px);margin:0 auto;padding:22px 16px max(26px,env(safe-area-inset-bottom))}
.hero{display:flex;align-items:flex-start;gap:14px;padding:4px 2px 8px}
.hero-icon{flex:0 0 58px;height:58px;border-radius:18px;display:grid;place-items:center;background:linear-gradient(145deg,#dbeafe,#eef6ff);color:var(--blue);font-size:30px;box-shadow:inset 0 0 0 1px rgba(23,105,232,.06)}
.hero-copy{min-width:0}
h2{margin:2px 0 6px;color:var(--navy);font-size:clamp(24px,7vw,32px);line-height:1.08;letter-spacing:-.03em}
.intro{margin:0;color:var(--muted);font-size:15px;line-height:1.45}
.info{position:relative;background:rgba(237,245,255,.92);border:1px solid #bfdbfe;padding:16px 16px 16px 50px;border-radius:18px;margin:14px 0 18px;font-size:14px;line-height:1.55;box-shadow:0 8px 24px rgba(15,78,155,.05)}
.info:before{content:"i";position:absolute;left:16px;top:16px;width:25px;height:25px;border-radius:999px;display:grid;place-items:center;background:var(--blue);color:#fff;font-weight:800;font-family:Georgia,serif}
.info b{display:block;color:var(--navy);font-size:16px;margin-bottom:5px}
form{margin:0}
fieldset,.approval-card{border:1px solid var(--line);background:rgba(255,255,255,.96);border-radius:20px;padding:16px;margin:0 0 14px;box-shadow:0 10px 28px rgba(15,35,70,.06)}
legend{font-size:18px;font-weight:800;color:var(--navy);padding:0 8px}
.field{margin:13px 0}
label{display:block;font-size:13px;color:#334155;margin-bottom:7px;font-weight:700}
input[type=text],input[type=password],input[type=number],textarea{width:100%;min-height:48px;padding:12px 14px;border:1px solid #cfd9e7;border-radius:12px;background:#fff;color:#0f172a;font-size:16px;box-sizing:border-box;font-family:inherit;outline:none;transition:border-color .18s,box-shadow .18s}
input::placeholder,textarea::placeholder{color:#94a3b8}
input:focus,textarea:focus{border-color:#70a7f5;box-shadow:0 0 0 4px rgba(37,99,235,.1)}
textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;min-height:112px;resize:vertical}
.row{display:grid;grid-template-columns:minmax(0,1fr) 108px;gap:12px}
.authmethod{display:flex;flex-wrap:wrap;gap:12px 22px;margin:8px 0 4px;font-size:14px}
.authmethod label{display:flex;align-items:center;gap:8px;font-weight:600;margin:0;color:#334155;cursor:pointer}
.authmethod input{width:19px;height:19px;accent-color:var(--blue)}
.approval-title{display:flex;align-items:center;gap:9px;margin:0 0 4px;color:var(--navy);font-size:17px;font-weight:800}
.approval-card .field{margin:10px 0}
.hint{font-size:12px;line-height:1.5;color:var(--muted);margin:10px 0 0;padding:10px 12px;border-radius:12px;background:#f8fafc;border:1px solid #e8eef6}
.actions{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:10px;margin-top:14px}
button{min-height:50px;padding:12px 16px;border:none;border-radius:13px;cursor:pointer;font-size:16px;font-weight:800;transition:transform .12s,filter .12s,box-shadow .12s}
button:active{transform:translateY(1px)}
.allow{background:linear-gradient(135deg,var(--blue),var(--blue2));color:#fff;box-shadow:0 8px 18px rgba(23,105,232,.22)}
.deny{background:var(--danger-soft);color:var(--danger);border:1px solid #fecdd3}
.timer{text-align:center;font-size:13px;color:var(--muted);margin:12px 0 0}
@media (max-width:380px){.page{padding-left:12px;padding-right:12px}.hero{gap:11px}.hero-icon{flex-basis:50px;height:50px;border-radius:15px;font-size:26px}h2{font-size:23px}.info{padding-left:46px}.row{grid-template-columns:minmax(0,1fr) 92px}.actions{grid-template-columns:1fr 1fr}fieldset,.approval-card{padding:14px}}
@media (min-width:700px){.page{padding-top:42px}.hero{padding-left:8px}.info{margin-top:18px}}
</style>
</head><body>
<main class="page">
<section class="hero">
  <div class="hero-icon" aria-hidden="true">🔒</div>
  <div class="hero-copy">
    <h2>MCP VPS2 - SSH Server</h2>
    <p class="intro">Masukkan detail koneksi SSH dan password untuk mengizinkan akses.</p>
  </div>
</section>
<div class="info"><b>Akses yang diberikan:</b>• Koneksi SSH ke server remote<br>• Eksekusi perintah via SSH<br>• Upload &amp; Download file via SSH<br>• Browse file via SSH<br>• Kontrol browser bersama Chromium<br><span style="color:#64748b">(password/OTP/token tidak diisi oleh AI)</span></div>
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
<section class="approval-card">
  <div class="approval-title">🔑 Password Approval</div>
  <div class="field"><label for="approvalPassword">Password persetujuan</label><input id="approvalPassword" type="password" name="password" placeholder="Masukkan password approval..." required></div>
  <p class="hint">Detail SSH di atas disimpan hanya di memori server selama sesi akses ini aktif, tidak pernah melewati percakapan Claude.</p>
</section>
<div class="actions">
  <button type="submit" name="action" value="allow" class="allow">✓&nbsp; Izinkan</button>
  <button type="submit" name="action" value="deny" class="deny">✕&nbsp; Tolak</button>
</div>
</form>
<p class="timer">⏱ Sesi expired dalam <span id="countdown">5:00</span></p>
</main>
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
    if (req.path === '/health' || req.path === '/upload-ui' || req.path === '/upload-file' || req.path.startsWith('/oauth') || req.path.startsWith('/.well-known')) return next();
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
  app.get('/upload-ui', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.type('html').send(`<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP File Upload</title></head>
<body style="font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 18px">
<h1>MCP File Upload</h1>
<p>Pilih file dari workspace Work. File akan dikirim sebagai binary langsung ke VPS tanpa Base64.</p>
<input id="file" type="file"><button id="upload" type="button">Upload</button>
<pre id="status" style="white-space:pre-wrap"></pre>
<script>
const statusEl=document.getElementById('status');
const token=new URLSearchParams(location.hash.slice(1)).get('token');
if(!token) statusEl.textContent='Token upload tidak ditemukan.';
document.getElementById('upload').onclick=async()=>{
  const file=document.getElementById('file').files[0];
  if(!token||!file) return statusEl.textContent='Pilih file terlebih dahulu.';
  statusEl.textContent='Mengunggah '+file.name+' ...';
  try {
    const r=await fetch('/upload-file',{method:'POST',headers:{'Authorization':'Upload '+token,'Content-Type':'application/octet-stream','X-Filename':file.name},body:file});
    const text=await r.text();
    statusEl.textContent=(r.ok?'Berhasil: ':'Gagal: ')+text;
  } catch(e) { statusEl.textContent='Gagal: '+e.message; }
};
</script></body></html>`);
  });

  app.post('/upload-file', (req, res, next) => {
    const ip = getClientIP(req);
    if (isUploadRateLimited(ip)) return res.status(429).json({ error: 'upload_rate_limited' });
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Upload ') ? auth.slice(7) : '';
    const slot = uploadSlots.get(token);
    if (!slot) return res.status(401).json({ error: 'invalid_or_used_upload_token' });
    if (Date.now() > slot.expiresAt) {
      uploadSlots.delete(token);
      return res.status(410).json({ error: 'upload_token_expired' });
    }
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > slot.maxBytes) {
      return res.status(413).json({ error: 'file_too_large', maxBytes: slot.maxBytes });
    }
    req.uploadToken = token;
    req.uploadSlot = slot;
    next();
  }, express.raw({ type: 'application/octet-stream', limit: `${MAX_UPLOAD_MAX_BYTES}b` }), async (req, res) => {
    const token = req.uploadToken;
    const slot = req.uploadSlot;
    if (!Buffer.isBuffer(req.body) || req.body.length < 1) return res.status(400).json({ error: 'empty_file' });
    if (req.body.length > slot.maxBytes) return res.status(413).json({ error: 'file_too_large', maxBytes: slot.maxBytes });
    const detectedKind = detectUploadKind(req.body);
    const validKind = slot.kind === 'apk' ? detectedKind === 'zip' : detectedKind === slot.kind;
    if (!validKind) return res.status(415).json({ error: 'file_signature_mismatch', expected: slot.kind });
    if (uploadSlots.get(token) !== slot) return res.status(401).json({ error: 'invalid_or_used_upload_token' });
    // Consume before upload so a successful/failed attempt cannot be replayed.
    uploadSlots.delete(token);
    try {
      await sshUploadBuffer(slot.connectionId, req.body, slot.remotePath, slot.allowOverwrite, slot.allowedRoots);
      console.error(`[UPLOAD] ok path=${slot.remotePath} bytes=${req.body.length} kind=${slot.kind} overwrite=${slot.allowOverwrite}`);
      res.json({ ok: true, remotePath: slot.remotePath, bytes: req.body.length, kind: slot.kind });
    } catch (err) {
      if (err.message === 'destination_exists') return res.status(409).json({ error: 'destination_exists' });
      console.error('[UPLOAD] failed:', err.message);
      res.status(500).json({ error: 'upload_failed' });
    }
  });

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
    status: 'ok', version: MCP_VERSION, mode: 'http', auth: 'oauth2-password-protected',
    tools: ['browser_view','browser_get_view_url','browser_set_mode','browser_open','browser_snapshot','browser_extract_text','browser_extract_transcript','browser_click','browser_type','browser_select','browser_wait','browser_screenshot','browser_execute_js','browser_tabs','browser_back','browser_reload','ssh_connect', 'ssh_exec', 'ssh_exec_persistent', 'ssh_close_shell', 'ssh_edit_file', 'ssh_exec_background', 'ssh_check_background', 'ssh_kill_background', 'ssh_upload', 'ssh_create_upload_slot', 'ssh_write_file', 'ssh_download', 'ssh_read_image', 'adb_screenshot_visual', 'ssh_list_files', 'ssh_repo_snapshot', 'ssh_checkpoint', 'ssh_repo_verify', 'ssh_repo_worktree', 'ssh_repo_review', 'ssh_repo_commit_push', 'ssh_project', 'browser_smoke', 'ssh_workspace', 'ssh_agent_board', 'ssh_disconnect', 'ssh_list_connections'],
    ssh_connections_active: sshConnections.size
  }));

  app.listen(PORT, BIND_HOST, () => {
    console.error(`MCP SSH Server v3.10.0: http://${BIND_HOST}:${PORT}`);
    console.error(`Mode: OAuth2 + Password + Rate Limiting + DCR + Upload/Download + Whitelist/Blacklist`);
  });

} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP SSH Server v3.10.0 siap! (stdio mode)');
}
