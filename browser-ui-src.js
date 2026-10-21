import { App } from '@modelcontextprotocol/ext-apps';
import { safeBrowserViewUrl, extractBrowserViewUrl } from './browser-session-compat.js';

const ORIGIN = __BROWSER_ORIGIN__;
const app = new App({ name: 'Browser Safara', version: '5.0.0' });
const frame = document.getElementById('browser');
const empty = document.getElementById('empty');
const status = document.getElementById('status');
const retry = document.getElementById('retry');
const desktop = document.getElementById('desktop');
const mobile = document.getElementById('mobile');
const external = document.getElementById('external');
let connected = false;
let opening = false;
let opened = false;

function openView(value) {
  const url = safeBrowserViewUrl(value, ORIGIN);
  if (!url || opened) return false;
  opened = true;
  frame.src = url;
  empty.hidden = true;
  status.textContent = 'Layar browser terbuka. Konfirmasikan sesi Safara pada layar.';
  return true;
}

// The Android host can deliver the original tool result before the app bridge
// finishes its handshake. Read only trusted signed links, never credentials.
function readHostMetadata() {
  try {
    const host = window.openai;
    const url = extractBrowserViewUrl(host?.toolResponseMetadata, ORIGIN) ||
      extractBrowserViewUrl(host?.toolOutput, ORIGIN) ||
      extractBrowserViewUrl(host, ORIGIN);
    return openView(url);
  } catch { return false; }
}

async function callTool(name, args = {}) {
  if (connected) return app.callServerTool({ name, arguments: args });
  if (typeof window.openai?.callTool === 'function') return window.openai.callTool(name, args);
  throw Error('MCP Apps bridge unavailable');
}

async function newSession() {
  const result = await callTool('browser_get_view_url');
  if (result?.isError) throw Error('Tidak dapat membuat tiket sesi');
  const url = extractBrowserViewUrl(result, ORIGIN);
  if (!url) throw Error('Tiket browser tidak sesuai domain atau format');
  return url;
}

async function showFrame() {
  if (opening) return;
  opening = true;
  retry.disabled = true;
  status.textContent = 'Meminta sesi browser baru…';
  try {
    const url = await newSession();
    // Explicit retry is allowed to refresh a used or expired signed link.
    opened = false;
    if (!openView(url)) throw Error('Tiket tidak valid');
  } catch {
    status.textContent = opened
      ? 'Sesi lama tersedia. Bila terputus, coba muat ulang.'
      : 'Gagal terhubung. Coba muat ulang atau buka layar penuh.';
    if (!opened) {
      empty.hidden = false;
      empty.textContent = 'Panel belum dapat menghubungi sesi browser Safara.';
    }
  } finally {
    retry.disabled = false;
    opening = false;
  }
}

async function setMode(mode) {
  try {
    const result = await callTool('browser_set_mode', { mode });
    if (result?.isError) throw Error('mode unavailable');
    status.textContent = mode === 'mobile' ? 'Tampilan mobile aktif' : 'Tampilan desktop aktif';
  } catch {
    status.textContent = 'Gagal mengubah mode browser';
  }
}

async function openExternal() {
  external.disabled = true;
  try {
    const url = await newSession();
    if (connected) await app.openLink({ url });
    else {
      const link = document.createElement('a');
      link.href = url;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      link.click();
    }
    status.textContent = 'Layar browser dibuka di luar panel.';
  } catch {
    status.textContent = 'Gagal membuka layar penuh. Coba lagi.';
  } finally {
    external.disabled = false;
  }
}

retry.addEventListener('click', showFrame);
desktop.addEventListener('click', () => setMode('desktop'));
mobile.addEventListener('click', () => setMode('mobile'));
external.addEventListener('click', openExternal);

async function start() {
  app.ontoolresult = result => {
    const url = extractBrowserViewUrl(result, ORIGIN);
    if (url) openView(url);
  };
  readHostMetadata();
  try {
    await app.connect();
    connected = true;
  } catch {
    if (!opened) status.textContent = 'Host MCP Apps tidak mendukung koneksi. Mencoba bridge kompatibilitas…';
  }
  retry.disabled = false;
  desktop.disabled = false;
  mobile.disabled = false;
  external.disabled = false;
  if (!opened && !readHostMetadata()) await showFrame();
}
start();
