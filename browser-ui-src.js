import { App } from '@modelcontextprotocol/ext-apps';

const ORIGIN = 'https://browser-vps.hijrah-attauhid.or.id';
const frame = document.getElementById('browser');
const loading = document.getElementById('loading');
const status = document.getElementById('status');
const external = document.getElementById('external');
const desktopBtn = document.getElementById('mode-desktop');
const mobileBtn = document.getElementById('mode-mobile');
const fullscreenBtn = document.getElementById('mode-fullscreen');

let opened = false;
let connected = false;
let currentMode = 'desktop';

function safeUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN || url.pathname !== '/embed/login') return null;
    if (!url.searchParams.get('nonce') || !url.searchParams.get('expires') || !url.searchParams.get('sig')) return null;
    return url.href;
  } catch {
    return null;
  }
}

function extractUrl(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  const direct = safeUrl(value.browserViewUrl) || safeUrl(value._meta?.browserViewUrl);
  if (direct) return direct;
  for (const key of ['result', 'params', 'toolOutput', 'toolResponseMetadata', 'mcp_tool_result', 'call_tool_result']) {
    const found = extractUrl(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function setModeUi(mode) {
  currentMode = mode;
  desktopBtn.classList.toggle('active', mode === 'desktop');
  mobileBtn.classList.toggle('active', mode === 'mobile');
  document.body.classList.toggle('mobile-mode', mode === 'mobile');
}

function openView(value) {
  const url = safeUrl(value);
  if (!url || opened) return false;
  opened = true;
  external.href = url;
  external.style.display = 'inline';
  status.textContent = 'Terhubung';
  loading.style.display = 'none';
  frame.style.display = 'block';
  frame.src = url;
  return true;
}

function openFromCompatibilityBridge() {
  try {
    const oa = window.openai;
    return openView(extractUrl(oa?.toolResponseMetadata))
      || openView(extractUrl(oa?.toolOutput))
      || openView(extractUrl(oa));
  } catch {
    return false;
  }
}

const app = new App({ name: 'Browser VPS At-Tauhid', version: '7.0.0' });

app.ontoolresult = (result) => {
  const url = extractUrl(result);
  if (url) {
    openView(url);
  } else if (!opened) {
    status.textContent = 'Hasil diterima, tiket belum ditemukan';
  }
};

app.ontoolcancelled = () => {
  if (!opened) status.textContent = 'Pemanggilan browser dibatalkan';
};

async function setBrowserMode(mode) {
  if (!connected || mode === currentMode) return;
  const previous = currentMode;
  setModeUi(mode);
  status.textContent = mode === 'mobile' ? 'Mengaktifkan mode mobile…' : 'Mengaktifkan mode desktop…';
  desktopBtn.disabled = true;
  mobileBtn.disabled = true;
  try {
    const result = await app.callServerTool({
      name: 'browser_set_mode',
      arguments: { mode }
    });
    if (result?.isError) throw new Error('browser_set_mode gagal');
    status.textContent = mode === 'mobile' ? 'Mobile · 390×844' : 'Desktop · 1366×768';
  } catch (error) {
    console.error('Failed to switch browser mode', error);
    setModeUi(previous);
    status.textContent = 'Gagal mengubah mode';
  } finally {
    desktopBtn.disabled = false;
    mobileBtn.disabled = false;
  }
}

desktopBtn.addEventListener('click', () => setBrowserMode('desktop'));
mobileBtn.addEventListener('click', () => setBrowserMode('mobile'));

fullscreenBtn.addEventListener('click', async () => {
  if (!connected) return;
  try {
    await app.requestDisplayMode({ mode: 'fullscreen' });
  } catch (error) {
    console.error('Fullscreen request failed', error);
    status.textContent = 'Fullscreen tidak tersedia';
  }
});

async function start() {
  setModeUi('desktop');
  openFromCompatibilityBridge();
  try {
    await app.connect();
    connected = true;
    desktopBtn.disabled = false;
    mobileBtn.disabled = false;
    fullscreenBtn.disabled = false;
    if (!opened) {
      status.textContent = 'Menunggu tiket browser…';
      openFromCompatibilityBridge();
    }
  } catch (error) {
    console.error('MCP App connect failed', error);
    status.textContent = 'Bridge MCP App gagal';
    loading.textContent = 'Panel berhasil dimuat, tetapi koneksi UI ke host gagal. Coba muat ulang konektor.';
    openFromCompatibilityBridge();
  }

  const timer = setInterval(() => {
    if (opened) return clearInterval(timer);
    openFromCompatibilityBridge();
  }, 250);

  setTimeout(() => {
    if (!opened) {
      clearInterval(timer);
      status.textContent = 'Tiket browser belum diterima';
      loading.textContent = 'Panel MCP App sudah aktif, tetapi tiket sesi browser belum diterima dari browser_view.';
    }
  }, 15000);
}

start();
