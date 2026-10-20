import { App } from '@modelcontextprotocol/ext-apps';

const ORIGIN = __BROWSER_ORIGIN__;
const app = new App({ name: 'Browser Safara', version: '4.0.0' });
const frame = document.getElementById('browser');
const empty = document.getElementById('empty');
const status = document.getElementById('status');
const retry = document.getElementById('retry');
const desktop = document.getElementById('desktop');
const mobile = document.getElementById('mobile');
const external = document.getElementById('external');
let connected = false;
let opening = false;

function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN || url.pathname !== '/browser/login' || url.username || url.password) return null;
    if (!/^[a-f0-9]{32}$/.test(url.searchParams.get('nonce') || '') ||
        !/^[a-f0-9]{64}$/.test(url.searchParams.get('sig') || '') ||
        !/^\d{13}$/.test(url.searchParams.get('expires') || '')) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function callTool(name, args = {}) {
  if (connected) return app.callServerTool({ name, arguments: args });
  if (typeof window.openai?.callTool === 'function') return window.openai.callTool(name, args);
  throw Error('MCP Apps bridge unavailable');
}

async function newSession() {
  const result = await callTool('browser_get_view_url');
  if (result?.isError) throw Error('Tidak dapat membuat tiket sesi');
  const url = safeUrl(result?.structuredContent?.url);
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
    frame.src = url;
    empty.hidden = true;
    status.textContent = 'Layar browser terbuka. Konfirmasikan sesi Safara pada layar.';
  } catch {
    status.textContent = 'Gagal terhubung. Coba muat ulang atau buka layar penuh.';
    empty.hidden = false;
    empty.textContent = 'Panel belum dapat menghubungi sesi browser Safara.';
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
  app.ontoolresult = () => {}; // Ticket always generated fresh by the app-only tool.
  try {
    await app.connect();
    connected = true;
  } catch {
    status.textContent = 'Host MCP Apps tidak mendukung koneksi. Mencoba bridge kompatibilitas…';
  }
  retry.disabled = false;
  desktop.disabled = false;
  mobile.disabled = false;
  external.disabled = false;
  await showFrame();
}
start();
