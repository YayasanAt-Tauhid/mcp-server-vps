import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOutput, formatExecResult, QUIET_ENV_PREFIX } from './output-sanitizer.js';

test('membuang kode warna ANSI (CSI)', () => {
  assert.equal(sanitizeOutput('\x1b[31mMERAH\x1b[0m biasa \x1b[1;32mhijau\x1b[m'), 'MERAH biasa hijau');
});

test('membuang sekuens OSC (judul terminal / hyperlink)', () => {
  assert.equal(sanitizeOutput('\x1b]0;judul\x07ok\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\'), 'oklink');
});

test('progress bar dengan \\r hanya menyisakan tahap terakhir', () => {
  assert.equal(sanitizeOutput('unduh 10%\runduh 55%\runduh 100%\nselesai\n'), 'unduh 100%\nselesai');
});

test('\\r di akhir baris tidak menghapus isi baris', () => {
  assert.equal(sanitizeOutput('loading\r'), 'loading');
});

test('CRLF dinormalisasi menjadi LF', () => {
  assert.equal(sanitizeOutput('a\r\nb\r\n'), 'a\nb');
});

test('backspace menghapus karakter sebelumnya', () => {
  assert.equal(sanitizeOutput('ab\bc'), 'ac');
});

test('baris kosong beruntun diringkas menjadi satu', () => {
  assert.equal(sanitizeOutput('a\n\n\n\n\nb'), 'a\n\nb');
});

test('output panjang dipotong head + tail dengan penanda', () => {
  const input = Array.from({ length: 500 }, (_, i) => `baris ${i + 1}`).join('\n');
  const out = sanitizeOutput(input, { headLines: 3, tailLines: 2 });
  assert.equal(out, 'baris 1\nbaris 2\nbaris 3\n…495 baris dihilangkan…\nbaris 499\nbaris 500');
});

test('batas karakter tetap berlaku untuk baris tunggal yang sangat panjang', () => {
  const out = sanitizeOutput('x'.repeat(50000), { maxChars: 1000 });
  assert.ok(out.length <= 1100, `panjang ${out.length}`);
  assert.match(out, /karakter dihilangkan/);
});

test('output pendek tidak diubah selain trim', () => {
  assert.equal(sanitizeOutput('  halo\n'), '  halo');
});

test('formatExecResult menyertakan stdout, stderr, dan exit code', () => {
  const out = formatExecResult({ stdout: 'hasil\n', stderr: 'peringatan\n', exitCode: 3 });
  assert.match(out, /hasil/);
  assert.match(out, /\[stderr\]\nperingatan/);
  assert.match(out, /\[exit code: 3\]$/);
});

test('formatExecResult tanpa output tetap memberi exit code', () => {
  assert.equal(formatExecResult({ stdout: '', stderr: '', exitCode: 0 }), '(tidak ada output)\n[exit code: 0]');
});

test('formatExecResult hanya stderr tidak diberi label ganda', () => {
  assert.equal(formatExecResult({ stdout: '', stderr: '\x1b[31mgagal\x1b[0m', exitCode: 1 }), '[stderr]\ngagal\n[exit code: 1]');
});

test('QUIET_ENV_PREFIX mematikan warna dan mode interaktif', () => {
  for (const v of ['NO_COLOR=1', 'CI=true', 'TERM=dumb']) assert.ok(QUIET_ENV_PREFIX.includes(v), v);
  assert.ok(QUIET_ENV_PREFIX.trimEnd().endsWith(';'));
});
