import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_IMAGE_MAX_BYTES,
  HARD_IMAGE_MAX_BYTES,
  assertAllowedImagePath,
  assertDeviceId,
  assertImageBuffer,
  detectImageMime,
  isPathInside,
  normalizeImageMaxBytes,
  toImageContent
} from './image-tools.js';

const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
const JPEG = Buffer.from([0xff,0xd8,0xff,0xdb,0x00]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0,0,0,0]), Buffer.from('WEBP'), Buffer.from([0])]);

test('detectImageMime validates supported magic bytes', () => {
  assert.equal(detectImageMime(PNG), 'image/png');
  assert.equal(detectImageMime(JPEG), 'image/jpeg');
  assert.equal(detectImageMime(WEBP), 'image/webp');
  assert.equal(detectImageMime(Buffer.from('not-an-image')), null);
});

test('assertImageBuffer enforces size and image signature', () => {
  assert.equal(assertImageBuffer(PNG), 'image/png');
  assert.throws(() => assertImageBuffer(Buffer.alloc(0)), /kosong/);
  assert.throws(() => assertImageBuffer(Buffer.from('plain text')), /magic bytes/);
  assert.throws(() => assertImageBuffer(Buffer.concat([PNG, Buffer.alloc(20)]), 8), /terlalu besar/);
});

test('image max byte limit is bounded', () => {
  assert.equal(normalizeImageMaxBytes(), DEFAULT_IMAGE_MAX_BYTES);
  assert.equal(normalizeImageMaxBytes(1024), 1024);
  assert.throws(() => normalizeImageMaxBytes(0));
  assert.throws(() => normalizeImageMaxBytes(HARD_IMAGE_MAX_BYTES + 1));
});

test('allowed image path blocks traversal outside configured roots', () => {
  assert.equal(isPathInside('/tmp', '/tmp/a.png'), true);
  assert.equal(isPathInside('/tmp', '/tmp2/a.png'), false);
  assert.equal(assertAllowedImagePath('/tmp/a.png', ['/tmp']), '/tmp/a.png');
  assert.throws(() => assertAllowedImagePath('/etc/shadow.png', ['/tmp', '/home/safara/backups']), /di luar/);
});

test('device id accepts adb serial syntax and rejects shell metacharacters', () => {
  assert.equal(assertDeviceId('RR8RB0B7F3A'), 'RR8RB0B7F3A');
  assert.equal(assertDeviceId('127.0.0.1:5555'), '127.0.0.1:5555');
  assert.throws(() => assertDeviceId('phone;rm -rf /'), /tidak valid/);
});

test('toImageContent produces MCP image content', () => {
  const content = toImageContent(PNG, 'image/png');
  assert.deepEqual(content, {
    type: 'image',
    data: PNG.toString('base64'),
    mimeType: 'image/png'
  });
});
