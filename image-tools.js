import { resolve, sep } from 'path';

export const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const HARD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export function isPathInside(root, candidate) {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r + sep);
}

export function normalizeImageMaxBytes(value) {
  if (value === undefined || value === null) return DEFAULT_IMAGE_MAX_BYTES;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > HARD_IMAGE_MAX_BYTES) {
    throw new Error(`maxBytes harus integer 1..${HARD_IMAGE_MAX_BYTES}`);
  }
  return n;
}

export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function assertImageBuffer(buffer, maxBytes = DEFAULT_IMAGE_MAX_BYTES) {
  const limit = normalizeImageMaxBytes(maxBytes);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('file gambar kosong');
  if (buffer.length > limit) throw new Error(`gambar terlalu besar (${buffer.length} bytes > ${limit})`);
  const mimeType = detectImageMime(buffer);
  if (!mimeType) throw new Error('format gambar tidak didukung atau magic bytes tidak valid');
  return mimeType;
}

export function assertAllowedImagePath(realPath, allowedRoots) {
  if (typeof realPath !== 'string' || !realPath.startsWith('/')) throw new Error('realPath harus absolut');
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) throw new Error('allowedRoots belum dikonfigurasi');
  if (!allowedRoots.some(root => isPathInside(root, realPath))) {
    throw new Error('path gambar di luar direktori yang diizinkan');
  }
  return realPath;
}

export function assertDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) {
    throw new Error('deviceId tidak valid');
  }
  return deviceId;
}

export function toImageContent(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) throw new Error('buffer gambar tidak valid');
  if (!/^image\/(png|jpeg|webp)$/.test(mimeType || '')) throw new Error('mimeType gambar tidak valid');
  return { type: 'image', data: buffer.toString('base64'), mimeType };
}
