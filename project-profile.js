import { assertAbsolutePath, containsSecretLike } from './workflow.js';
import { normalizeAllowedBrowserHosts } from './browser-smoke.js';

const MAX_PROJECT_ROOTS = 20;
const MAX_PROJECT_HOSTS = 30;
const MAX_PROJECT_SMOKE_URLS = 10;
const MAX_PROJECT_SERVICES = 12;

function assertOnlyKeys(value, allowed, field) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(field + ' memiliki field tidak dikenal: ' + key);
  }
}

function assertSafeText(value, field, max = 200, required = false) {
  if (value == null) {
    if (required) throw new Error(field + ' wajib');
    return null;
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(field + ' tidak valid');
  }
  if (containsSecretLike(value)) throw new Error(field + ' ditolak karena pola secret/credential');
  return value.trim();
}

export function assertProjectId(value, field = 'projectId') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(field + ' harus lowercase slug 1-64 karakter');
  }
  return value;
}

export function assertSystemdServiceName(value, field = 'service') {
  if (typeof value !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,126}\.service$/.test(value) ||
      value.includes('..')) {
    throw new Error(field + ' bukan systemd service name yang aman');
  }
  return value;
}

function normalizeAbsoluteRoots(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_PROJECT_ROOTS) throw new Error(field + ' harus array maksimum 20 path');
  const roots = [...new Set(value.map((item, index) => {
    assertAbsolutePath(item, field + '[' + index + ']');
    if (item === '/' || item === '/home' || item === '/root' || item === '/etc' || item === '/var') {
      throw new Error(field + ' terlalu luas: ' + item);
    }
    return item.replace(/\/$/, '') || '/';
  }))];
  return roots;
}

function normalizeServices(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_PROJECT_SERVICES) {
    throw new Error('services harus array maksimum ' + MAX_PROJECT_SERVICES);
  }
  return [...new Set(value.map((item, index) => assertSystemdServiceName(item, 'services[' + index + ']')))];
}

function normalizeSmokeUrl(value, browserHosts, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2000) throw new Error(field + ' tidak valid');
  let url;
  try { url = new URL(value); } catch { throw new Error(field + ' tidak valid'); }
  if (url.protocol !== 'https:') throw new Error(field + ' wajib HTTPS');
  if (url.username || url.password) throw new Error(field + ' tidak boleh memiliki credential');
  if (url.port && url.port !== '443') throw new Error(field + ' hanya boleh port 443');
  if (url.search || url.hash) throw new Error(field + ' tidak boleh memiliki query/hash');
  const host = url.hostname.toLowerCase();
  const matches = browserHosts.some(rule => rule.startsWith('.') ? host.endsWith(rule) && host.length > rule.length : host === rule);
  if (!matches) throw new Error(field + ' host tidak ada pada browserHosts');
  return url.origin + (url.pathname || '/');
}

function normalizeSmokeUrls(value, browserHosts) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_PROJECT_SMOKE_URLS) {
    throw new Error('smokeUrls harus array maksimum ' + MAX_PROJECT_SMOKE_URLS);
  }
  return [...new Set(value.map((item, index) => normalizeSmokeUrl(item, browserHosts, 'smokeUrls[' + index + ']')))];
}

function normalizeBrowserHostsForProject(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_PROJECT_HOSTS) throw new Error('browserHosts harus array maksimum 30 host');
  if (value.length === 0) return [];
  return normalizeAllowedBrowserHosts(value);
}

function normalizeTimestamp(value, field, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(field + ' timestamp tidak valid');
  return new Date(value).toISOString();
}

export function normalizeProjectProfile(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('project profile harus object');
  assertOnlyKeys(input, [
    'version', 'projectId', 'displayName', 'repoPath', 'handbookPath',
    'browserHosts', 'smokeUrls', 'services', 'uploadRoots', 'imageRoots',
    'createdAt', 'updatedAt'
  ], 'project profile');

  const projectId = assertProjectId(input.projectId);
  const displayName = assertSafeText(input.displayName || projectId, 'displayName', 120, true);
  assertAbsolutePath(input.repoPath, 'repoPath');
  if (['/','/home','/root','/etc','/var'].includes(input.repoPath.replace(/\/$/, '') || '/')) throw new Error('repoPath terlalu luas');
  const repoPath = input.repoPath.replace(/\/$/, '');
  let handbookPath = null;
  if (input.handbookPath != null) {
    assertAbsolutePath(input.handbookPath, 'handbookPath');
    if (['/','/home','/root','/etc','/var'].includes(input.handbookPath.replace(/\/$/, '') || '/')) throw new Error('handbookPath terlalu luas');
    handbookPath = input.handbookPath.replace(/\/$/, '');
  }
  if (handbookPath === repoPath) throw new Error('handbookPath harus berbeda dari repoPath');

  const browserHosts = normalizeBrowserHostsForProject(input.browserHosts);
  const smokeUrls = normalizeSmokeUrls(input.smokeUrls, browserHosts);
  const services = normalizeServices(input.services);
  const uploadRoots = normalizeAbsoluteRoots(input.uploadRoots, 'uploadRoots');
  const imageRoots = normalizeAbsoluteRoots(input.imageRoots, 'imageRoots');

  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const createdAt = normalizeTimestamp(input.createdAt, 'createdAt', now);
  const updatedAt = normalizeTimestamp(input.updatedAt, 'updatedAt', now);

  const profile = {
    version: 1,
    projectId,
    displayName,
    repoPath,
    handbookPath,
    browserHosts,
    smokeUrls,
    services,
    uploadRoots,
    imageRoots,
    createdAt,
    updatedAt
  };
  const serialized = JSON.stringify(profile);
  if (containsSecretLike(serialized)) throw new Error('project profile ditolak karena pola secret/credential');
  return profile;
}

export function updateProjectProfile(existing, patch, options = {}) {
  const current = normalizeProjectProfile(existing, options);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('project patch harus object');
  if ('projectId' in patch && patch.projectId !== current.projectId) throw new Error('projectId tidak boleh diubah');
  if ('createdAt' in patch) throw new Error('createdAt tidak boleh diubah');
  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  return normalizeProjectProfile({
    ...current,
    ...patch,
    projectId: current.projectId,
    createdAt: current.createdAt,
    updatedAt: now
  }, { now });
}
