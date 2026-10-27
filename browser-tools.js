import { chromium } from 'playwright';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { displayConfig, parseDisplayState } from './browser-display.js';
const runFile = promisify(execFile);

const CDP_URL = process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222';
let browserClient = null;
let activePage = null;
let displayMode = 'desktop';
let defaultUserAgent = null;
const cdpSessions = new WeakMap();
const DISPLAY_MODE_STATE_FILE = process.env.BROWSER_DISPLAY_MODE_STATE_FILE || '/tmp/attauhid-browser-display-mode';

let currentDisplay = displayConfig('desktop');
let modeQueue = Promise.resolve();

function readDisplayModeState() {
  try { currentDisplay = parseDisplayState(readFileSync(DISPLAY_MODE_STATE_FILE, 'utf8')); } catch {}
  return currentDisplay.mode;
}

function writeDisplayModeState(config) {
  const temporary = DISPLAY_MODE_STATE_FILE + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
  renameSync(temporary, DISPLAY_MODE_STATE_FILE);
}

export function browserCurrentMode() {
  displayMode = readDisplayModeState();
  return displayMode;
}

export function browserCurrentDisplay() {
  readDisplayModeState();
  return currentDisplay;
}

async function syncSharedScreen(page, config) {
  const session = await getCdpSession(page);
  const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
  const windowState = config.mobile ? 'fullscreen' : 'maximized';
  if (bounds.windowState !== windowState) {
    if (!config.mobile) await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
  }
  // noVNC must receive the portrait framebuffer, not the full desktop scaled down.
  const clip = config.mobile ? `${config.width}x${config.height}+0+0` : '';
  await runFile('x11vnc', ['-display', process.env.BROWSER_X_DISPLAY || ':99', '-sync', '-R', 'clip:' + clip], { timeout: 7000 });
}

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
  displayMode = readDisplayModeState();
  const cfg = currentDisplay;
  const session = await getCdpSession(page);
  {
    if (!defaultUserAgent) {
      const version = await session.send('Browser.getVersion').catch(() => null);
      defaultUserAgent = version?.userAgent || null;
    }
    if (displayMode === 'desktop') {
      await session.send('Emulation.clearDeviceMetricsOverride');
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
          userAgent: mobileUa.replace(/(Chrome\/[\d.]+)(?! Mobile)/, '$1 Mobile'),
          platform: 'Android'
        }).catch(() => {});
      }
    }
  }
}

async function applyDisplayModeToAllPages() {
  const context = await getContext();
  const pages = context.pages().filter(p => !p.url().startsWith('chrome-extension://'));
  await Promise.all(pages.map(page => applyDisplayMode(page)));
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
  const run = async () => {
    const mode = String(args.mode || '').toLowerCase();
    const config = displayConfig(mode, args);
    const context = await getContext();
    const pages = context.pages().filter(p => !p.url().startsWith('chrome-extension://'));
    const visible = await Promise.all(pages.map(async p => await p.evaluate(() => document.visibilityState === 'visible').catch(() => false)));
    const page = typeof args.tabIndex === 'number' ? pages[args.tabIndex] : pages[visible.indexOf(true)] || pages[0];
    if (!page) throw new Error('Tab browser tidak tersedia');
    await syncSharedScreen(page, config);
    currentDisplay = config;
    displayMode = mode;
    writeDisplayModeState(config);
    await applyDisplayModeToAllPages();
    const viewport = await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio, userAgent: navigator.userAgent }));
    return { mode, target: config, viewport, ...(await summarize(page)) };
  };
  const pending = modeQueue.then(run, run);
  modeQueue = pending.catch(() => {});
  return pending;
}

export async function browserScroll(args = {}) {
  const direction = String(args.direction || 'down').toLowerCase();
  if (!['up','down'].includes(direction)) throw new Error('direction harus up atau down');
  const page = await getPage(args.tabIndex);
  const fraction = Math.min(1.25, Math.max(0.35, Number(args.fraction || 0.82)));
  const result = await page.evaluate(({ direction, fraction }) => {
    const findScrollable = () => {
      let el = document.elementFromPoint(Math.max(1, innerWidth / 2), Math.max(1, innerHeight / 2));
      while (el && el !== document.documentElement) {
        const style = getComputedStyle(el);
        const canScroll = /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4;
        if (canScroll) return el;
        el = el.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    };
    const target = findScrollable();
    const amount = Math.max(180, Math.round(innerHeight * fraction)) * (direction === 'down' ? 1 : -1);
    const isRoot = target === document.scrollingElement || target === document.documentElement || target === document.body;
    const before = isRoot ? scrollY : target.scrollTop;
    if (isRoot) window.scrollBy({ top: amount, behavior: 'auto' });
    else target.scrollBy({ top: amount, behavior: 'auto' });
    const after = isRoot ? scrollY : target.scrollTop;
    const max = isRoot
      ? Math.max(0, (document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight) - innerHeight)
      : Math.max(0, target.scrollHeight - target.clientHeight);
    return { direction, before, after, max, moved: after !== before };
  }, { direction, fraction });
  return { ...result, ...(await summarize(page)) };
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

function paginateBrowserText(output, args = {}) {
  const text = String(output ?? '');
  const resultLength = text.length;
  const offset = Math.max(0, Math.floor(Number(args.offset || 0)));
  const maxChars = Math.min(Math.max(Math.floor(Number(args.maxChars || 200000)), 1000), 200000);
  const chunkStart = Math.min(offset, resultLength);
  const chunkEnd = Math.min(chunkStart + maxChars, resultLength);
  const result = text.slice(chunkStart, chunkEnd);
  const hasMore = chunkEnd < resultLength;
  return {
    result,
    resultLength,
    returnedLength: result.length,
    offset: chunkStart,
    chunkEnd,
    nextOffset: hasMore ? chunkEnd : null,
    hasMore,
    truncated: hasMore
  };
}

async function autoScrollFrame(frame, steps = 12) {
  const count = Math.min(Math.max(Math.floor(Number(steps || 12)), 1), 60);
  for (let i = 0; i < count; i++) {
    const state = await frame.evaluate(() => {
      const root = document.scrollingElement || document.documentElement;
      const before = root.scrollTop;
      const max = Math.max(0, root.scrollHeight - root.clientHeight);
      if (before >= max - 2) return { done: true, before, max };
      root.scrollBy(0, Math.max(400, Math.round(innerHeight * 0.85)));
      return { done: false, before, max };
    }).catch(() => ({ done: true }));
    if (state.done) break;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
}

async function extractFrameText(frame, selector = 'body') {
  return await frame.evaluate(({ selector }) => {
    const root = document.querySelector(selector);
    if (!root) return { text: '', shadowText: '', matched: false };
    const clean = value => String(value || '').replace(/\r\n/g, '\n').trim();
    const shadowParts = [];
    const visit = node => {
      if (!node || !node.querySelectorAll) return;
      for (const el of node.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const shadowValue = clean(el.shadowRoot.innerText || el.shadowRoot.textContent || '');
          if (shadowValue) shadowParts.push(shadowValue);
          visit(el.shadowRoot);
        }
      }
    };
    visit(root);
    return {
      text: clean(root.innerText || root.textContent || ''),
      shadowText: shadowParts.join('\n'),
      matched: true
    };
  }, { selector }).catch(() => ({ text: '', shadowText: '', matched: false }));
}

export async function browserExtractText(args = {}) {
  const page = await getPage(args.tabIndex);
  const selector = String(args.selector || 'body');
  const includeFrames = args.includeFrames !== false;
  const includeShadowDom = args.includeShadowDom !== false;
  const frames = includeFrames ? page.frames() : [page.mainFrame()];

  if (args.autoScroll) {
    await autoScrollFrame(page.mainFrame(), args.maxScrollSteps || 12);
  }

  const sections = [];
  for (const frame of frames) {
    const extracted = await extractFrameText(frame, selector);
    if (!extracted.matched) continue;
    const parts = [];
    if (extracted.text) parts.push(extracted.text);
    if (includeShadowDom && extracted.shadowText) parts.push(extracted.shadowText);
    const text = parts.join('\n').trim();
    if (!text) continue;
    sections.push({
      url: frame.url(),
      name: frame.name() || null,
      text
    });
  }

  const combined = sections.map(section => {
    if (sections.length === 1) return section.text;
    return `[FRAME ${section.url || 'about:blank'}]\n${section.text}`;
  }).join('\n\n');

  return {
    success: true,
    selector,
    frameCount: sections.length,
    ...paginateBrowserText(combined, args),
    info: await summarize(page)
  };
}

export async function browserExtractTranscript(args = {}) {
  const page = await getPage(args.tabIndex);
  const includeFrames = args.includeFrames !== false;
  const frames = includeFrames ? page.frames() : [page.mainFrame()];
  const customSelector = args.selector ? String(args.selector) : null;
  const genericSelectors = [
    '[class*="caption-window" i]',
    '[class*="closed-caption" i]',
    '[class*="live-caption" i]',
    '[class*="live-transcript" i]',
    '[class*="transcription" i]',
    '[class~="caption"]',
    '[class~="transcript"]',
    '[class~="subtitle"]',
    '[id*="closed-caption" i]',
    '[id*="live-transcript" i]',
    '[id*="transcription" i]',
    '[aria-label*="closed caption" i]',
    '[aria-label*="live transcript" i]',
    '[aria-label*="transcription" i]'
  ];
  const meetingOnlySelectors = [
    '[data-testid*="caption" i]',
    '[data-testid*="transcript" i]',
    '[role="log"]',
    '[aria-live="polite"]',
    '[aria-live="assertive"]'
  ];

  const collected = [];
  for (const frame of frames) {
    let isMeetingHost = false;
    try {
      const host = new URL(frame.url()).hostname.toLowerCase();
      isMeetingHost = host === 'zoom.us' || host.endsWith('.zoom.us') ||
        host === 'zoom.com' || host.endsWith('.zoom.com') ||
        host === 'meet.google.com' || host === 'teams.microsoft.com' ||
        host.endsWith('.teams.microsoft.com');
    } catch {}
    const selectors = customSelector
      ? [customSelector]
      : (isMeetingHost ? [...genericSelectors, ...meetingOnlySelectors] : genericSelectors);

    const entries = await frame.evaluate(({ selectors }) => {
      const clean = value => String(value || '').replace(/\r\n/g, '\n').trim();
      const seen = new Set();
      const out = [];
      for (const selector of selectors) {
        let nodes = [];
        try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
        for (const el of nodes) {
          const text = clean(el.innerText || el.textContent || '');
          if (!text || seen.has(text)) continue;
          seen.add(text);
          out.push({ selector, text });
        }
      }
      return out;
    }, { selectors }).catch(() => []);

    for (const entry of entries) {
      collected.push({
        frameUrl: frame.url(),
        selector: entry.selector,
        text: entry.text
      });
    }
  }

  let lines = collected.flatMap(item => item.text.split('\n')).map(line => line.trim()).filter(Boolean);
  if (args.dedupe !== false) {
    const seen = new Set();
    lines = lines.filter(line => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
  }

  const combined = lines.join('\n');
  return {
    success: true,
    found: collected.length > 0,
    sourceCount: collected.length,
    frameCount: new Set(collected.map(item => item.frameUrl)).size,
    selectorsMatched: [...new Set(collected.map(item => item.selector))],
    ...paginateBrowserText(combined, args),
    info: await summarize(page)
  };
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
    // Normalize screenshot viewport. Some Chromium sessions keep a mobile
    // emulation DPR/scale (for example CSS 1560x2760 rendered as PNG 390x690).
    // Keep browser_screenshot behavior unchanged; this normalization only
    // applies to browser_screenshot_view.
    const metrics = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight
    })).catch(() => null);
    if (metrics?.width && metrics?.height) {
      const session = await getCdpSession(page);
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(metrics.width),
        height: Math.round(metrics.height),
        deviceScaleFactor: 1,
        mobile: false
      }).catch(() => {});
    }
    const data = await page.screenshot({ type: 'png', fullPage: !!args.fullPage });
    return {
      info: await summarize(page),
      image: data.toString('base64')
    };
  } finally {
    await page.evaluate(() => document.querySelectorAll('[data-mcp-sensitive-mask]').forEach(el => el.remove())).catch(() => {});
  }
}

export async function browserExecuteJs(args = {}) {
  const page = await getPage(args.tabIndex);
  const script = String(args.script || '');
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs || 10000), 1000), 30000);
  if (!script) throw new Error('script wajib diisi');

  let timeoutId;
  let result;
  try {
    result = await Promise.race([
      page.evaluate((code) => (0, eval)(code), script),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('JavaScript timeout')), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  let output;
  try {
    if (typeof result === 'string') output = result;
    else if (result === undefined) output = 'undefined';
    else output = JSON.stringify(result) ?? String(result);
  } catch {
    output = String(result);
  }

  const resultLength = output.length;
  const offset = Math.max(0, Math.floor(Number(args.offset || 0)));
  const maxChars = Math.min(Math.max(Math.floor(Number(args.maxChars || 200000)), 1000), 200000);
  const chunkStart = Math.min(offset, resultLength);
  const chunkEnd = Math.min(chunkStart + maxChars, resultLength);
  const chunk = output.slice(chunkStart, chunkEnd);
  const hasMore = chunkEnd < resultLength;

  return {
    success: true,
    result: chunk,
    resultLength,
    returnedLength: chunk.length,
    offset: chunkStart,
    chunkEnd,
    nextOffset: hasMore ? chunkEnd : null,
    hasMore,
    truncated: hasMore,
    info: await summarize(page)
  };
}

export async function browserExportPdf(args = {}) {
  const page = await getPage(args);
  await applyDisplayMode(page);
  const session = await getCdpSession(page);
  const result = await session.send('Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true
  });
  return { info: await summarize(page), pdf: result.data };
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
