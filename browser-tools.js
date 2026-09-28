import { chromium } from 'playwright-core';

const CDP_URL = process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222';
let browserClient = null;
let activePage = null;
let displayMode = 'desktop';
let defaultUserAgent = null;
const cdpSessions = new WeakMap();

const DISPLAY_MODES = {
  desktop: { width: 1366, height: 768, mobile: false, touch: false },
  mobile: { width: 390, height: 844, mobile: true, touch: true }
};

async function getCdpSession(page) {
  let session = cdpSessions.get(page);
  if (session) return session;
  const context = await getContext();
  session = await context.newCDPSession(page);
  cdpSessions.set(page, session);
  page.once('close', () => {
    cdpSessions.delete(page);
    session.detach().catch(() => {});
  });
  return session;
}

async function applyDisplayMode(page) {
  const cfg = DISPLAY_MODES[displayMode] || DISPLAY_MODES.desktop;
  const session = await getCdpSession(page);
  {
    if (!defaultUserAgent) {
      const version = await session.send('Browser.getVersion').catch(() => null);
      defaultUserAgent = version?.userAgent || null;
    }
    if (displayMode === 'desktop') {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: cfg.width,
        height: cfg.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: cfg.width,
        screenHeight: cfg.height,
        screenOrientation: { type: 'landscapePrimary', angle: 90 }
      });
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      if (defaultUserAgent) {
        await session.send('Emulation.setUserAgentOverride', {
          userAgent: defaultUserAgent,
          platform: 'Linux'
        }).catch(() => {});
      }
    } else {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: cfg.width,
        height: cfg.height,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: cfg.width,
        screenHeight: cfg.height,
        screenOrientation: { type: 'portraitPrimary', angle: 0 }
      });
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});
      if (defaultUserAgent) {
        const mobileUa = defaultUserAgent.includes('(X11; Linux x86_64)')
          ? defaultUserAgent.replace('(X11; Linux x86_64)', '(Linux; Android 13; Pixel 7)')
          : defaultUserAgent;
        await session.send('Emulation.setUserAgentOverride', {
          userAgent: mobileUa,
          platform: 'Android'
        }).catch(() => {});
      }
    }
  }
}

async function applyDisplayModeToAllPages() {
  const context = await getContext();
  const pages = context.pages().filter(p => !p.url().startsWith('chrome-extension://'));
  await Promise.all(pages.map(page => applyDisplayMode(page).catch(() => {})));
}

const SECRET_RE = /(password|passwd|passcode|otp|one[-_ ]?time|token|secret|pin|2fa|mfa|verification[-_ ]?code|security[-_ ]?code)/i;

async function getBrowser() {
  if (browserClient && browserClient.isConnected()) return browserClient;
  browserClient = await chromium.connectOverCDP(CDP_URL);
  browserClient.on('disconnected', () => {
    browserClient = null;
    activePage = null;
  });
  return browserClient;
}

async function getContext() {
  const browser = await getBrowser();
  const context = browser.contexts()[0];
  if (!context) throw new Error('Browser context tidak tersedia. Pastikan attauhid-browser.service aktif.');
  return context;
}

async function getPage(tabIndex) {
  const context = await getContext();
  const pages = context.pages().filter(p => !p.url().startsWith('chrome-extension://'));
  if (typeof tabIndex === 'number') {
    if (!pages[tabIndex]) throw new Error('Tab index tidak ditemukan: ' + tabIndex);
    activePage = pages[tabIndex];
    await applyDisplayMode(activePage).catch(() => {});
    return activePage;
  }
  if (activePage && !activePage.isClosed() && pages.includes(activePage)) {
    await applyDisplayMode(activePage).catch(() => {});
    return activePage;
  }
  activePage = pages[0] || await context.newPage();
  await applyDisplayMode(activePage).catch(() => {});
  return activePage;
}

function assertHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('URL tidak valid'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Hanya URL http/https yang diizinkan');
  return u.toString();
}

function locatorFor(page, args) {
  if (args.ref) return page.locator('[data-mcp-ref="' + String(args.ref).replace(/"/g, '\\"') + '"]').first();
  if (args.selector) return page.locator(args.selector).first();
  if (args.text) return page.getByText(args.text, { exact: args.exact !== false }).first();
  throw new Error('Isi ref, selector, atau text');
}

async function summarize(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState
  }));
}

export async function browserSetMode(args = {}) {
  const mode = String(args.mode || '').toLowerCase();
  if (!DISPLAY_MODES[mode]) throw new Error('mode harus desktop atau mobile');
  displayMode = mode;
  await applyDisplayModeToAllPages();
  const page = await getPage(args.tabIndex);
  await page.waitForTimeout(250);
  const viewport = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent
  })).catch(() => null);
  return { mode: displayMode, target: DISPLAY_MODES[displayMode], viewport, ...(await summarize(page)) };
}

export async function browserOpen(args = {}) {
  const page = await getPage(args.tabIndex);
  const url = assertHttpUrl(args.url);
  await page.goto(url, { waitUntil: 'commit', timeout: args.timeoutMs || 15000 });
  await page.waitForTimeout(args.settleMs ?? 1200);
  return await summarize(page);
}

export async function browserSnapshot(args = {}) {
  const page = await getPage(args.tabIndex);
  const limit = Math.min(Math.max(Number(args.limit || 120), 1), 250);
  const data = await page.evaluate(({ limit }) => {
    document.querySelectorAll('[data-mcp-ref]').forEach(el => el.removeAttribute('data-mcp-ref'));
    const visible = el => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
    };
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')]
      .filter(visible)
      .slice(0, limit);
    const interactive = nodes.map((el, i) => {
      const ref = 'e' + i;
      el.setAttribute('data-mcp-ref', ref);
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase() || null;
      const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || clean(el.innerText || el.textContent);
      return {
        ref,
        tag,
        type,
        role: el.getAttribute('role') || null,
        label: clean(label).slice(0, 180) || null,
        text: ['button','a'].includes(tag) ? clean(el.innerText || el.textContent).slice(0, 180) : null,
        href: tag === 'a' ? el.href : null,
        disabled: !!el.disabled
      };
    });
    const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0, 40).map(h => clean(h.innerText || h.textContent)).filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      headings,
      bodyText: clean(document.body?.innerText || '').slice(0, 8000),
      interactive
    };
  }, { limit });
  return data;
}

export async function browserClick(args = {}) {
  const page = await getPage(args.tabIndex);
  const loc = locatorFor(page, args);
  await loc.click({ timeout: args.timeoutMs || 15000 });
  await page.waitForTimeout(args.settleMs ?? 700);
  return await summarize(page);
}

export async function browserType(args = {}) {
  const page = await getPage(args.tabIndex);
  const loc = locatorFor(page, args);
  const meta = await loc.evaluate(el => ({
    type: (el.getAttribute('type') || '').toLowerCase(),
    id: el.id || '',
    name: el.getAttribute('name') || '',
    placeholder: el.getAttribute('placeholder') || '',
    autocomplete: el.getAttribute('autocomplete') || '',
    ariaLabel: el.getAttribute('aria-label') || ''
  }));
  const fingerprint = Object.values(meta).join(' ');
  if (meta.type === 'password' || ['current-password','new-password','one-time-code'].includes(meta.autocomplete) || SECRET_RE.test(fingerprint)) {
    throw new Error('Field sensitif terdeteksi. Password/OTP/token/PIN harus dimasukkan pengguna langsung melalui browser bersama.');
  }
  const value = String(args.value ?? '');
  if (args.append) await loc.type(value, { delay: args.delayMs || 0 });
  else await loc.fill(value);
  return { ...(await summarize(page)), typed: true };
}

export async function browserSelect(args = {}) {
  const page = await getPage(args.tabIndex);
  const loc = locatorFor(page, args);
  const options = Array.isArray(args.values) ? args.values.map(String) : [String(args.value ?? '')];
  if (!options.length || !options[0]) throw new Error('Isi value atau values');
  const selected = await loc.selectOption(options);
  return { ...(await summarize(page)), selected };
}

export async function browserWait(args = {}) {
  const page = await getPage(args.tabIndex);
  const timeout = Math.min(Math.max(Number(args.timeoutMs || 10000), 0), 60000);
  if (args.selector) await page.locator(args.selector).first().waitFor({ state: args.state || 'visible', timeout });
  else if (args.text) await page.getByText(args.text, { exact: args.exact === true }).first().waitFor({ state: args.state || 'visible', timeout });
  else if (args.urlContains) await page.waitForURL(url => url.toString().includes(args.urlContains), { timeout });
  else await page.waitForTimeout(Math.min(timeout, 10000));
  return await summarize(page);
}

export async function browserScreenshot(args = {}) {
  const page = await getPage(args.tabIndex);
  await page.evaluate(() => {
    document.querySelectorAll('[data-mcp-sensitive-mask]').forEach(el => el.remove());
    const secretRe = /(password|passwd|passcode|otp|one[-_ ]?time|token|secret|pin|2fa|mfa|verification[-_ ]?code|security[-_ ]?code)/i;
    for (const el of document.querySelectorAll('input,textarea')) {
      const meta = [
        el.getAttribute('type') || '',
        el.id || '',
        el.getAttribute('name') || '',
        el.getAttribute('placeholder') || '',
        el.getAttribute('autocomplete') || '',
        el.getAttribute('aria-label') || ''
      ].join(' ');
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if ((el.getAttribute('type') || '').toLowerCase() !== 'password' &&
          !['current-password','new-password','one-time-code'].includes(ac) &&
          !secretRe.test(meta)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const mask = document.createElement('div');
      mask.setAttribute('data-mcp-sensitive-mask', '1');
      Object.assign(mask.style, {
        position: 'fixed',
        left: r.left + 'px',
        top: r.top + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
        zIndex: '2147483647',
        background: '#222',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        font: '12px sans-serif',
        pointerEvents: 'none'
      });
      mask.textContent = 'SENSITIVE';
      document.documentElement.appendChild(mask);
    }
  });
  try {
    const data = await page.screenshot({ type: 'png', fullPage: !!args.fullPage });
    return {
      info: await summarize(page),
      image: data.toString('base64')
    };
  } finally {
    await page.evaluate(() => document.querySelectorAll('[data-mcp-sensitive-mask]').forEach(el => el.remove())).catch(() => {});
  }
}

export async function browserTabs(args = {}) {
  const context = await getContext();
  let pages = context.pages().filter(p => !p.url().startsWith('chrome-extension://'));
  const action = args.action || 'list';

  if (action === 'new') {
    activePage = await context.newPage();
    await applyDisplayMode(activePage).catch(() => {});
    if (args.url) {
      await activePage.goto(assertHttpUrl(args.url), { waitUntil: 'commit', timeout: args.timeoutMs || 15000 });
      await activePage.waitForTimeout(800);
    }
  } else if (action === 'select') {
    activePage = await getPage(Number(args.index));
    await activePage.bringToFront();
  } else if (action === 'close') {
    const idx = Number(args.index);
    if (!pages[idx]) throw new Error('Tab index tidak ditemukan: ' + idx);
    await pages[idx].close();
    pages = context.pages().filter(p => !p.url().startsWith('chrome-extension://'));
    activePage = pages[Math.max(0, Math.min(idx - 1, pages.length - 1))] || null;
  } else if (action !== 'list') {
    throw new Error('action harus list, new, select, atau close');
  }

  pages = context.pages().filter(p => !p.url().startsWith('chrome-extension://'));
  const result = [];
  for (let i = 0; i < pages.length; i++) {
    result.push({
      index: i,
      active: pages[i] === activePage,
      title: await pages[i].title().catch(() => ''),
      url: pages[i].url()
    });
  }
  return result;
}

export async function browserBack(args = {}) {
  const page = await getPage(args.tabIndex);
  await page.goBack({ waitUntil: 'commit', timeout: args.timeoutMs || 15000 }).catch(() => null);
  await page.waitForTimeout(700);
  return await summarize(page);
}

export async function browserReload(args = {}) {
  const page = await getPage(args.tabIndex);
  await page.reload({ waitUntil: 'commit', timeout: args.timeoutMs || 15000 });
  await page.waitForTimeout(700);
  return await summarize(page);
}
