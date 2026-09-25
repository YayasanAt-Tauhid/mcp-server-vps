import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAllowedBrowserHosts,
  normalizeBrowserSmokeRequest,
  runBrowserSmoke
} from './browser-smoke.js';

test('browser smoke host allowlist accepts project subdomains and local HTTP', () => {
  const rules = normalizeAllowedBrowserHosts(['project.example', '.project.example', '127.0.0.1', 'localhost']);
  const a = normalizeBrowserSmokeRequest({ url: 'https://app.project.example/' }, rules);
  assert.equal(a.url, 'https://app.project.example/');
  const b = normalizeBrowserSmokeRequest({ url: 'http://127.0.0.1:3100/health', screenshot: false }, rules);
  assert.equal(b.screenshot, false);
});

test('browser smoke rejects external host, public HTTP, credentials and secret-like query keys', () => {
  const rules = normalizeAllowedBrowserHosts(['.project.example', '127.0.0.1']);
  assert.throws(() => normalizeBrowserSmokeRequest({ url: 'https://example.com/' }, rules), /tidak diizinkan/);
  assert.throws(() => normalizeBrowserSmokeRequest({ url: 'http://app.project.example/' }, rules), /wajib HTTPS/);
  assert.throws(() => normalizeBrowserSmokeRequest({ url: 'https://u:p@app.project.example/' }, rules), /credential/);
  assert.throws(() => normalizeBrowserSmokeRequest({ url: 'https://app.project.example/?access_token=abc' }, rules), /sensitif/);
});

test('browser smoke rejects public non-443 and disallowed localhost ports before launch', async () => {
  const rules = normalizeAllowedBrowserHosts(['.project.example', '127.0.0.1']);
  await assert.rejects(() => runBrowserSmoke({ url: 'https://app.project.example:8443/' }, rules, [3100]), /port HTTPS 443/);
  await assert.rejects(() => runBrowserSmoke({ url: 'http://127.0.0.1:8000/' }, rules, [3100]), /port localhost/);
});

test('browser smoke normalizes checks and bounded timeout', () => {
  const rules = normalizeAllowedBrowserHosts(['.project.example']);
  const r = normalizeBrowserSmokeRequest({
    url: 'https://app.project.example/path#fragment',
    expectedStatus: [200, 204, 200],
    expectedText: 'Project',
    expectedTitle: 'Project',
    timeoutMs: 12000
  }, rules);
  assert.deepEqual(r.expectedStatus, [200, 204]);
  assert.equal(r.url, 'https://app.project.example/path');
  assert.equal(r.timeoutMs, 12000);
  assert.throws(() => normalizeBrowserSmokeRequest({ url: 'https://app.project.example/', timeoutMs: 40000 }, rules), /timeoutMs/);
});
