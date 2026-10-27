import test from 'node:test';
import assert from 'node:assert/strict';
import {
  paginateBrowserText,
  resolveMaxChars,
  BROWSER_DEFAULT_MAX_CHARS,
  BROWSER_MAX_CHARS_LIMIT
} from './browser-tools.js';

test('default maxChars browser 30000, batas maksimum tetap 200000', () => {
  assert.equal(BROWSER_DEFAULT_MAX_CHARS, 30000);
  assert.equal(BROWSER_MAX_CHARS_LIMIT, 200000);
});

test('resolveMaxChars: tanpa argumen memakai default baru', () => {
  assert.equal(resolveMaxChars({}), 30000);
  assert.equal(resolveMaxChars(), 30000);
});

test('resolveMaxChars: nilai eksplisit dihormati dan di-clamp 1000..200000', () => {
  assert.equal(resolveMaxChars({ maxChars: 5000 }), 5000);
  assert.equal(resolveMaxChars({ maxChars: 200000 }), 200000);
  assert.equal(resolveMaxChars({ maxChars: 999999 }), 200000);
  assert.equal(resolveMaxChars({ maxChars: 10 }), 1000);
});

test('paginateBrowserText memotong ke default 30000 dan memberi nextOffset', () => {
  const r = paginateBrowserText('x'.repeat(100000));
  assert.equal(r.returnedLength, 30000);
  assert.equal(r.hasMore, true);
  assert.equal(r.nextOffset, 30000);
});

test('paginateBrowserText: halaman kecil tidak terpotong', () => {
  const r = paginateBrowserText('halo');
  assert.equal(r.hasMore, false);
  assert.equal(r.nextOffset, null);
  assert.equal(r.result, 'halo');
});

test('paginateBrowserText: maxChars 200000 masih bisa diminta eksplisit', () => {
  const r = paginateBrowserText('x'.repeat(150000), { maxChars: 200000 });
  assert.equal(r.returnedLength, 150000);
  assert.equal(r.hasMore, false);
});
