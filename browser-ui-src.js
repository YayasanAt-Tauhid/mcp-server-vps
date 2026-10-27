import { App } from '@modelcontextprotocol/ext-apps';

const ORIGIN = 'https://browser-vps.hijrah-attauhid.or.id';
const frame = document.getElementById('browser');
const loading = document.getElementById('loading');
const status = document.getElementById('status');
const external = document.getElementById('external');
const desktopBtn = document.getElementById('mode-desktop');
const mobileBtn = document.getElementById('mode-mobile');
const fullscreenBtn = document.getElementById('mode-fullscreen');
const retryBtn = document.getElementById('mode-retry');
let viewState = 'connecting';
let viewTimeout;

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
  status.textContent = 'Menghubungkan layar…';
  viewTimeout = setTimeout(() => {
    if (viewState !== 'connected') status.textContent = 'Layar belum tersambung — buka ulang panel jika sesi berakhir';
  }, 20000);
  loading.style.display = 'none';
  frame.style.display = 'block';
  frame.src = url;
  return true;
}

function showViewState() {
  const labels = {
    connecting: 'Menghubungkan layar…',
    connected: 'Terhubung',
    disconnected: 'Koneksi terputus',
    error: 'Gagal terhubung',
    auth: 'Sesi berakhir — buka ulang panel'
  };
  status.textContent = labels[viewState] || labels.connecting;
  retryBtn.hidden = !['error', 'disconnected'].includes(viewState);
}

window.addEventListener('message', (event) => {
  if (event.origin !== ORIGIN || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (data?.type !== 'attauhid-browser-state' ||
      !['connecting', 'connected', 'disconnected', 'error', 'auth'].includes(data.state)) return;
  viewState = data.state;
  clearTimeout(viewTimeout);
  if (['desktop', 'mobile'].includes(data.mode)) setModeUi(data.mode);
  showViewState();
});

retryBtn.addEventListener('click', () => {
  frame.contentWindow?.postMessage({ type: 'attauhid-browser-retry' }, ORIGIN);
});

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

const app = new App({ name: 'Browser VPS At-Tauhid', version: '7.1.0' });

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
    frame.contentWindow?.postMessage({ type: 'attauhid-browser-mode-refresh' }, ORIGIN);
    showViewState();
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
  fullscreenBtn.disabled = true;
  try {
    // ChatGPT Android currently recreates the MCP widget when native/app
    // fullscreen is requested, which produces a blank white surface. Avoid
    // that host path entirely: open the same signed browser session in a
    // dedicated top-level browser surface instead.
    const session = await app.callServerTool({ name: 'browser_get_view_url', arguments: {} });
    const url = safeUrl(session?.structuredContent?.url);
    if (!url) throw new Error('Sesi browser belum tersedia');
    await app.openLink({ url });
    status.textContent = 'Dibuka layar penuh';
  } catch (error) {
    console.error('Open full browser failed', error);
    status.textContent = 'Layar penuh gagal dibuka';
  } finally {
    fullscreenBtn.disabled = false;
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
      status.textContent = 'Mengambil sesi browser…';
      try {
        const session = await app.callServerTool({
          name: 'browser_get_view_url',
          arguments: {}
        });
        const directUrl = safeUrl(session?.structuredContent?.url);
        if (directUrl) openView(directUrl);
      } catch (error) {
        console.error('Failed to get browser view URL', error);
      }
    }

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
