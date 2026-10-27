import test from 'node:test';
import assert from 'node:assert/strict';
import { toolJson } from './tool-json.js';

test('toolJson menghasilkan JSON ringkas tanpa indentasi', () => {
  const out = toolJson({ a: 1, b: [1, 2, { c: 'x' }] });
  assert.equal(out, '{"a":1,"b":[1,2,{"c":"x"}]}');
  assert.ok(!out.includes('\n'));
});

test('toolJson tetap bisa di-parse balik tanpa kehilangan data', () => {
  const value = { ok: true, nested: { list: [1, 'dua', null] }, text: 'baris1\nbaris2' };
  assert.deepEqual(JSON.parse(toolJson(value)), value);
});

test('toolJson tidak mengembalikan undefined untuk nilai yang tak bisa di-serialize', () => {
  assert.equal(typeof toolJson(undefined), 'string');
  assert.equal(toolJson(undefined), 'null');
});

test('toolJson tidak melempar untuk referensi melingkar', () => {
  const a = {}; a.self = a;
  assert.equal(typeof toolJson(a), 'string');
});
