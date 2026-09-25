import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAllowedBrowserHosts,
  normalizeBrowserSmokeRequest,
  runBrowserSmoke
} from './browser-smoke.js';

test('browser smoke host allowlist accepts Safara subdomains and local HTTP', () => {
  const rules = normalizeAllowedBrowserHosts(['safara.biz.id', '.safara.biz.id', '127.0.0.1', 'localhost']);
  const a = normalizeBrowserSmokeRequest({ url: 'https://app.safara.biz.id/' }, rules);
  assert.equal(a.url, 'https://app.safara.biz.id/');
  const b = normalizeBrowserSmokeRequest({ url: 'http://127.0.0.1:3100/health', screenshot: false }, rules);
  assert.equal(b.screenshot, false);
});

test('browser smoke rejects external host, public HTTP, credentials and secret-like query keys', () => {
  const rules = normalizeAllowedBrowserHosts(['.safara.biz.id', '127.0.0.1']);
  assert.throws(() => normalizeBrowserSmokeRequest({ url: 'https://example.com/' }, rules), /tidak diizinkan/);
  assert.throws(() => normalizeBrowserSmokeRequest({ url: 'http://app.safara.biz.id/' }, rules), /wajib HTTPS/);
  assert.throws(() => normalizeBrowserSmokeRequest({ url: 'https://u:p@app.safara.biz.id/' }, rules), /credential/);
  assert.throws(() => normalizeBrowserSmokeRequest({ url: 'https://app.safara.biz.id/?access_token=abc' }, rules), /sensitif/);
});

test('browser smoke rejects public non-443 and disallowed localhost ports before launch', async () => {
  const rules = normalizeAllowedBrowserHosts(['.safara.biz.id', '127.0.0.1']);
  await assert.rejects(() => runBrowserSmoke({ url: 'https://app.safara.biz.id:8443/' }, rules, [3100]), /port HTTPS 443/);
  await assert.rejects(() => runBrowserSmoke({ url: 'http://127.0.0.1:8000/' }, rules, [3100]), /port localhost/);
});

test('browser smoke normalizes checks and bounded timeout', () => {
  const rules = normalizeAllowedBrowserHosts(['.safara.biz.id']);
  const r = normalizeBrowserSmokeRequest({
    url: 'https://app.safara.biz.id/path#fragment',
    expectedStatus: [200, 204, 200],
    expectedText: 'Safara',
    expectedTitle: 'Safara',
    timeoutMs: 12000
  }, rules);
  assert.deepEqual(r.expectedStatus, [200, 204]);
  assert.equal(r.url, 'https://app.safara.biz.id/path');
  assert.equal(r.timeoutMs, 12000);
  assert.throws(() => normalizeBrowserSmokeRequest({ url: 'https://app.safara.biz.id/', timeoutMs: 40000 }, rules), /timeoutMs/);
});
