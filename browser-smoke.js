const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const SENSITIVE_QUERY_KEY = /(?:^|[_-])(token|secret|password|passwd|api[_-]?key|signature|credential|auth)(?:$|[_-])/i;

function hostMatches(hostname, rule) {
  const host = String(hostname || '').toLowerCase();
  const normalized = String(rule || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('.')) return host.endsWith(normalized) && host.length > normalized.length;
  return host === normalized;
}

export function normalizeAllowedBrowserHosts(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(',');
  const rules = [...new Set(input.map(v => String(v).trim().toLowerCase()).filter(Boolean))];
  if (!rules.length) throw new Error('browser smoke allowed hosts kosong');
  if (rules.length > 50) throw new Error('browser smoke allowed hosts terlalu banyak');
  for (const rule of rules) {
    if (rule === '*' || /[\\/\s]/.test(rule) || !/^\.?[a-z0-9.-]+$/.test(rule)) {
      throw new Error('browser smoke allowed host tidak valid: ' + rule);
    }
  }
  return rules;
}

export function normalizeBrowserSmokeRequest(input = {}, allowedHosts = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('browser smoke request harus object');
  if (typeof input.url !== 'string' || input.url.length < 1 || input.url.length > 2000) throw new Error('url browser smoke tidak valid');

  let url;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error('url browser smoke tidak valid');
  }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('browser smoke hanya mendukung http/https');
  if (url.username || url.password) throw new Error('browser smoke menolak credential pada URL');

  const rules = normalizeAllowedBrowserHosts(allowedHosts);
  if (!rules.some(rule => hostMatches(url.hostname, rule))) {
    throw new Error('host browser smoke tidak diizinkan: ' + url.hostname);
  }

  const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !isLocal) throw new Error('browser smoke publik wajib HTTPS');

  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) throw new Error('browser smoke menolak query parameter sensitif');
  }
  url.hash = '';

  const expectedStatus = input.expectedStatus == null ? [200] :
    (Array.isArray(input.expectedStatus) ? input.expectedStatus : [input.expectedStatus]);
  if (expectedStatus.length < 1 || expectedStatus.length > 10 ||
      expectedStatus.some(v => !Number.isInteger(v) || v < 100 || v > 599)) {
    throw new Error('expectedStatus harus status HTTP valid');
  }

  const normalizeOptional = (value, field, max) => {
    if (value == null) return null;
    if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\r\n\0]/.test(value)) {
      throw new Error(field + ' tidak valid');
    }
    return value;
  };

  const expectedText = normalizeOptional(input.expectedText, 'expectedText', 500);
  const expectedTitle = normalizeOptional(input.expectedTitle, 'expectedTitle', 300);
  const timeoutMs = input.timeoutMs == null ? DEFAULT_TIMEOUT_MS : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('timeoutMs harus 1000-30000');
  }

  const maxScreenshotBytes = input.maxScreenshotBytes == null ? DEFAULT_MAX_SCREENSHOT_BYTES : Number(input.maxScreenshotBytes);
  if (!Number.isInteger(maxScreenshotBytes) || maxScreenshotBytes < 1024 || maxScreenshotBytes > MAX_SCREENSHOT_BYTES) {
    throw new Error('maxScreenshotBytes tidak valid');
  }

  return {
    url: url.toString(),
    expectedStatus: [...new Set(expectedStatus)],
    expectedText,
    expectedTitle,
    timeoutMs,
    screenshot: input.screenshot !== false,
    maxScreenshotBytes,
    allowedHosts: rules
  };
}

function assertAllowedRequestUrl(value, rules) {
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) return true;
  if (!['https:', 'http:'].includes(parsed.protocol)) return false;
  const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !isLocal) return false;
  return rules.some(rule => hostMatches(parsed.hostname, rule));
}

export async function runBrowserSmoke(input, allowedHosts, allowedLocalPorts = [3100]) {
  const request = normalizeBrowserSmokeRequest(input, allowedHosts);
  const initial = new URL(request.url);
  const initialIsLocal = ['127.0.0.1', 'localhost', '::1'].includes(initial.hostname.toLowerCase());
  const localPorts = [...new Set((Array.isArray(allowedLocalPorts) ? allowedLocalPorts : [allowedLocalPorts]).map(Number))];
  if (localPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('allowedLocalPorts tidak valid');
  }
  if (initialIsLocal && !localPorts.includes(Number(initial.port || (initial.protocol === 'https:' ? 443 : 80)))) {
    throw new Error('port localhost browser smoke tidak diizinkan');
  }
  if (!initialIsLocal && initial.port && initial.port !== '443') {
    throw new Error('browser smoke publik hanya mengizinkan port HTTPS 443');
  }

  const publicRules = request.allowedHosts.filter(rule => !['127.0.0.1', 'localhost', '::1'].includes(rule.replace(/^\./, '')));
  const requestAllowedRules = initialIsLocal ? [initial.hostname.toLowerCase()] : publicRules;

  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.BROWSER_SMOKE_BROWSERS_PATH || '/opt/mcp-development/playwright-browsers';
  const { chromium } = await import('playwright');

  let browser;
  let context;
  const counters = { consoleErrors: 0, pageErrors: 0, blockedRequests: 0 };
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true
    });
    context = await browser.newContext({
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      viewport: { width: 1365, height: 768 },
      serviceWorkers: 'block'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(request.timeoutMs);
    page.on('console', msg => { if (msg.type() === 'error') counters.consoleErrors++; });
    page.on('pageerror', () => { counters.pageErrors++; });

    await page.route('**/*', async route => {
      const reqUrl = route.request().url();
      if (assertAllowedRequestUrl(reqUrl, requestAllowedRules)) {
        if (initialIsLocal) {
          try {
            const parsed = new URL(reqUrl);
            if (['http:', 'https:'].includes(parsed.protocol)) {
              const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
              if (!localPorts.includes(port)) {
                counters.blockedRequests++;
                return route.abort('blockedbyclient');
              }
            }
          } catch {}
        }
        return route.continue();
      }
      counters.blockedRequests++;
      return route.abort('blockedbyclient');
    });

    const started = Date.now();
    const response = await page.goto(request.url, {
      waitUntil: 'domcontentloaded',
      timeout: request.timeoutMs
    });
    if (!response) throw new Error('browser navigation tidak menghasilkan HTTP response');

    await page.waitForTimeout(350);
    const status = response.status();
    const finalUrl = page.url();
    if (!assertAllowedRequestUrl(finalUrl, request.allowedHosts)) {
      throw new Error('redirect browser keluar allowlist');
    }

    const title = await page.title();
    const bodyText = await page.locator('body').innerText({ timeout: request.timeoutMs }).catch(() => '');
    const statusOk = request.expectedStatus.includes(status);
    const textOk = request.expectedText == null ? true : bodyText.includes(request.expectedText);
    const titleOk = request.expectedTitle == null ? true : title.includes(request.expectedTitle);
    const ok = statusOk && textOk && titleOk;

    let screenshot = null;
    if (request.screenshot) {
      screenshot = await page.screenshot({ type: 'png', fullPage: false });
      if (!Buffer.isBuffer(screenshot) || screenshot.length < 8 || screenshot.length > request.maxScreenshotBytes) {
        throw new Error('screenshot browser tidak valid atau terlalu besar');
      }
    }

    return {
      ok,
      status,
      finalUrl: (() => { const u = new URL(finalUrl); return u.origin + u.pathname; })(),
      title: title.slice(0, 300),
      elapsedMs: Date.now() - started,
      bodyTextLength: bodyText.length,
      checks: {
        status: statusOk,
        expectedText: request.expectedText == null ? 'SKIP' : textOk,
        expectedTitle: request.expectedTitle == null ? 'SKIP' : titleOk
      },
      diagnostics: counters,
      screenshot
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
