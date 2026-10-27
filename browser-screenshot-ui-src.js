import { App } from '@modelcontextprotocol/ext-apps';

const image = document.getElementById('screenshot');
const pdf = document.getElementById('pdf');
const loading = document.getElementById('loading');
const status = document.getElementById('status');
let rendered = false;

function safeDataUrl(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('data:image/png;base64,')) return null;
  const payload = value.slice('data:image/png;base64,'.length);
  if (!payload || !/^[A-Za-z0-9+/=]+$/.test(payload)) return null;
  return value;
}

function safePdfData(value) {
  if (typeof value !== 'string') return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return null;
  return value;
}

function extractPdf(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  const direct = safePdfData(value.pdfData) || safePdfData(value._meta?.pdfData);
  if (direct) return direct;
  for (const key of ['result', 'params', 'toolOutput', 'toolResponseMetadata', 'mcp_tool_result', 'call_tool_result']) {
    const found = extractPdf(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function extractScreenshot(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  const direct = safeDataUrl(value.screenshotDataUrl) || safeDataUrl(value._meta?.screenshotDataUrl);
  if (direct) return direct;
  for (const key of ['result', 'params', 'toolOutput', 'toolResponseMetadata', 'mcp_tool_result', 'call_tool_result']) {
    const found = extractScreenshot(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function renderPdf(value) {
  const data = safePdfData(value);
  if (!data) return false;
  pdf.src = 'data:application/pdf;base64,' + data;
  pdf.hidden = false;
  image.hidden = true;
  loading.hidden = true;
  status.textContent = 'PDF siap';
  rendered = true;
  return true;
}

function renderScreenshot(value) {
  const src = safeDataUrl(value);
  if (!src) return false;
  image.src = src;
  image.hidden = false;
  pdf.hidden = true;
  loading.hidden = true;
  image.onload = () => {
    try {
      app.sendSizeChanged({
        width: Math.min(window.innerWidth, 1280),
        height: Math.min(image.clientHeight || image.naturalHeight, window.innerHeight * 2)
      });
    } catch {}
  };
  status.textContent = 'Screenshot siap';
  rendered = true;
  return true;
}

function renderFromCompatibilityBridge() {
  try {
    const oa = window.openai;
    return renderScreenshot(extractScreenshot(oa?.toolResponseMetadata))
      || renderScreenshot(extractScreenshot(oa?.toolOutput))
      || renderScreenshot(extractScreenshot(oa));
  } catch {
    return false;
  }
}

const app = new App({ name: 'Browser Screenshot VPS At-Tauhid', version: '1.0.0' });

app.ontoolresult = (result) => {
  const pdfData = extractPdf(result);
  const src = extractScreenshot(result);
  if (!renderPdf(pdfData) && !renderScreenshot(src) && !rendered) status.textContent = 'Data screenshot/PDF belum diterima';
};

app.ontoolcancelled = () => {
  if (!rendered) status.textContent = 'Pemanggilan screenshot dibatalkan';
};

async function start() {
  renderFromCompatibilityBridge();
  try {
    await app.connect();
    if (!rendered) {
      status.textContent = 'Menunggu screenshot…';
      renderFromCompatibilityBridge();
    }
  } catch (error) {
    console.error('MCP screenshot app connect failed', error);
    if (!rendered) {
      status.textContent = 'Bridge MCP App gagal';
      renderFromCompatibilityBridge();
    }
  }

  const timer = setInterval(() => {
    if (rendered) return clearInterval(timer);
    renderFromCompatibilityBridge();
  }, 250);

  setTimeout(() => {
    if (!rendered) {
      clearInterval(timer);
      loading.textContent = 'Screenshot belum diterima dari browser_screenshot_view.';
      status.textContent = 'Screenshot belum tersedia';
    }
  }, 15000);
}

start();
