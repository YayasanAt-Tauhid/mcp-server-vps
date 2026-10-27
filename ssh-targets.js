// Registry target SSH: satu file JSON per VPS di MCP_TARGETS_DIR.
// Hanya admin (root, lewat CLI mcp-target) yang menambah target; model hanya
// bisa memilih nama target terdaftar. Autentikasi selalu memakai key, dan host
// key dipin dengan fingerprint SHA256 agar koneksi tidak bisa dibajak (MITM).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const TARGETS_DIR = process.env.MCP_TARGETS_DIR || '/etc/mcp-vps/targets.d';
export const DEFAULT_KEY_FILE = process.env.MCP_SSH_KEY_FILE || '/etc/mcp-vps/keys/id_ed25519';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const ACL_KEYS = ['whitelist', 'blacklist'];

export function fingerprintHostKey(blob) {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

function regexList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${field} harus array string regex`);
  for (const pattern of value) {
    try { new RegExp(pattern); } catch { throw new Error(`${field} berisi regex tidak valid: ${pattern}`); }
  }
  return [...value];
}

function pathList(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !isAbsolute(v) || v.includes('\0'))) {
    throw new Error(`${field} harus array path absolut`);
  }
  return [...value];
}

const homeOf = (username) => (username === 'root' ? '/root' : `/home/${username}`);

export function validateTarget(raw, name) {
  if (!NAME_RE.test(String(name))) throw new Error(`nama target tidak valid: "${name}" (huruf kecil, angka, tanda minus; maks 32)`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('target harus objek JSON');
  if ('password' in raw) throw new Error('password tidak didukung; registry hanya memakai SSH key');
  if (!HOST_RE.test(String(raw.host ?? ''))) throw new Error('host tidak valid');
  const port = raw.port === undefined ? 22 : raw.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port harus bilangan bulat 1-65535');
  if (!USER_RE.test(String(raw.username ?? ''))) throw new Error('username tidak valid');
  if (!Array.isArray(raw.hostKeys) || raw.hostKeys.length === 0 || raw.hostKeys.some((k) => !FP_RE.test(String(k)))) {
    throw new Error('hostKeys wajib berisi minimal satu fingerprint "SHA256:..."');
  }
  if (raw.keyFile !== undefined && raw.keyFile !== null && (typeof raw.keyFile !== 'string' || !isAbsolute(raw.keyFile))) {
    throw new Error('keyFile harus path absolut');
  }
  return {
    name,
    host: raw.host,
    port,
    username: raw.username,
    hostKeys: [...raw.hostKeys],
    keyFile: raw.keyFile || null,
    whitelist: regexList(raw.whitelist, 'whitelist'),
    blacklist: regexList(raw.blacklist, 'blacklist'),
    description: typeof raw.description === 'string' ? raw.description.slice(0, 200) : '',
    uploadRoots: pathList(raw.uploadRoots, 'uploadRoots', [homeOf(raw.username), '/tmp']),
    imageReadRoots: pathList(raw.imageReadRoots, 'imageReadRoots', [homeOf(raw.username), '/tmp'])
  };
}

// Dibaca ulang setiap dipanggil: menambah/menghapus target tidak perlu restart.
export function loadTargets(dir = TARGETS_DIR) {
  const targets = new Map();
  const errors = [];
  let files;
  try { files = readdirSync(dir); } catch (err) {
    if (err.code === 'ENOENT') return { targets, errors };
    throw err;
  }
  for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const t = validateTarget(raw, file.slice(0, -5));
      targets.set(t.name, t);
    } catch (err) {
      errors.push({ file, error: err.message });
    }
  }
  return { targets, errors };
}

export function buildConnectConfig(target, { defaultKeyFile = DEFAULT_KEY_FILE } = {}) {
  const keyPath = target.keyFile || defaultKeyFile;
  let privateKey;
  try { privateKey = readFileSync(keyPath); } catch (err) {
    throw new Error(`key SSH untuk target "${target.name}" tidak dapat dibaca (${err.code || err.message})`);
  }
  const pinned = new Set(target.hostKeys);
  return {
    host: target.host,
    port: target.port,
    username: target.username,
    privateKey,
    readyTimeout: 20000,
    hostVerifier: (keyBlob) => pinned.has(fingerprintHostKey(keyBlob)),
    whitelist: target.whitelist,
    blacklist: target.blacklist,
    uploadRoots: target.uploadRoots,
    imageReadRoots: target.imageReadRoots
  };
}

export function stripAclArgs(args) {
  const out = { ...(args || {}) };
  for (const k of ACL_KEYS) delete out[k];
  return out;
}

export function stripAclFromSchemas(tools) {
  return tools.map((tool) => {
    const props = tool.inputSchema?.properties;
    if (!props || !ACL_KEYS.some((k) => k in props)) return tool;
    const properties = Object.fromEntries(Object.entries(props).filter(([k]) => !ACL_KEYS.includes(k)));
    const inputSchema = { ...tool.inputSchema, properties };
    if (Array.isArray(tool.inputSchema.required)) inputSchema.required = tool.inputSchema.required.filter((k) => !ACL_KEYS.includes(k));
    return { ...tool, inputSchema };
  });
}

export function describeTargets(targets) {
  if (!targets.size) return '(belum ada target terdaftar)';
  return [...targets.values()]
    .map((t) => `- ${t.name}: ${t.username}@${t.host}:${t.port}${t.description ? ` — ${t.description}` : ''}`)
    .join('\n');
}
