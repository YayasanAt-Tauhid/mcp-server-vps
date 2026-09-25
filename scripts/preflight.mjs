#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

function argValue(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function commandExists(name) {
  try {
    execFileSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const envPath = resolve(argValue('--env-file', '.env'));
const allowPlaceholders = process.argv.includes('--allow-placeholders');
const runtime = process.argv.includes('--runtime');
const errors = [];
const warnings = [];

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) errors.push('Node.js >= 20 diperlukan');
for (const command of ['node', 'npm', 'git', 'systemctl']) {
  if (!commandExists(command)) errors.push('binary tidak ditemukan: ' + command);
}

if (!existsSync(envPath)) {
  errors.push('env file tidak ditemukan: ' + envPath);
} else {
  const env = parseEnv(readFileSync(envPath, 'utf8'));
  for (const key of ['APPROVE_PASSWORD', 'BASE_URL', 'PORT', 'BIND_HOST']) {
    if (!env[key]) errors.push('env key wajib belum diisi: ' + key);
    if (!allowPlaceholders && /CHANGE_ME|SET_ME|example\.com/i.test(env[key] || '')) {
      errors.push('env key masih placeholder: ' + key);
    }
  }
  if (!env.MCP_TOKEN) warnings.push('MCP_TOKEN kosong: static bearer-token access tidak tersedia; OAuth flow tetap dapat dipakai');
  if (!allowPlaceholders && /CHANGE_ME|SET_ME/i.test(env.MCP_TOKEN || '')) errors.push('MCP_TOKEN masih placeholder');
  if (env.BIND_HOST !== '127.0.0.1' && env.BIND_HOST !== '::1') {
    warnings.push('BIND_HOST bukan loopback; pastikan firewall/reverse proxy memang membutuhkan bind publik');
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT tidak valid');
  const concurrency = Number(env.WORKSPACE_VERIFY_CONCURRENCY || '2');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) errors.push('WORKSPACE_VERIFY_CONCURRENCY harus 1-3');

  if (runtime) {
    const browserPath = env.BROWSER_SMOKE_BROWSERS_PATH || '/opt/mcp-development/playwright-browsers';
    if (!existsSync(browserPath)) warnings.push('browser smoke path belum tersedia: ' + browserPath);
  }
}

console.log(JSON.stringify({
  ok: errors.length === 0,
  node: process.version,
  envFile: envPath,
  checks: {
    binaries: errors.filter(x => x.startsWith('binary')).length === 0,
    configuration: errors.filter(x => x.startsWith('env ') || x.startsWith('PORT') || x.startsWith('WORKSPACE')).length === 0
  },
  warnings,
  errors
}, null, 2));

if (errors.length) process.exit(2);
