// Membersihkan output terminal sebelum dikirim ke model agar hemat token:
// buang ANSI/OSC, progress bar (\r), backspace, baris kosong beruntun,
// lalu potong head + tail. Batas bisa diatur lewat env.

const envInt = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const DEFAULT_LIMITS = Object.freeze({
  headLines: envInt('MCP_OUTPUT_HEAD_LINES', 80),
  tailLines: envInt('MCP_OUTPUT_TAIL_LINES', 80),
  maxChars: envInt('MCP_OUTPUT_MAX_CHARS', 12000)
});

// Prefix shell agar program tidak mengeluarkan warna, pager, atau progress interaktif.
export const QUIET_ENV_PREFIX = 'export NO_COLOR=1 FORCE_COLOR=0 CI=true TERM=dumb PAGER=cat GIT_PAGER=cat; ';

const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC2 = /\x1b[@-Z\\^_]/g;
const CTRL = /[\x00-\x07\x0B\x0C\x0E-\x1F\x7F]/g; // sisakan \b(08) \t(09) \n(0A) \r(0D)

function applyBackspaces(text) {
  if (!text.includes('\x08')) return text;
  let prev;
  do { prev = text; text = text.replace(/[^\n\x08]\x08/g, ''); } while (text !== prev);
  return text.replace(/\x08/g, '');
}

function lastSegment(line) {
  if (!line.includes('\r')) return line;
  const segs = line.split('\r').filter((s) => s.length > 0);
  return segs.length ? segs[segs.length - 1] : '';
}

export function sanitizeOutput(value, limits = {}) {
  const { headLines, tailLines, maxChars } = { ...DEFAULT_LIMITS, ...limits };
  let text = String(value ?? '')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESC2, '')
    .replace(/\r\n/g, '\n');
  text = applyBackspaces(text).replace(CTRL, '');

  const lines = [];
  for (const raw of text.split('\n')) {
    const line = lastSegment(raw).trimEnd();
    if (line === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  let out;
  if (lines.length > headLines + tailLines + 1) {
    const omitted = lines.length - headLines - tailLines;
    out = [...lines.slice(0, headLines), `…${omitted} baris dihilangkan…`, ...lines.slice(-tailLines)].join('\n');
  } else {
    out = lines.join('\n');
  }

  if (out.length > maxChars) {
    const headChars = Math.floor(maxChars * 0.6);
    const tailChars = maxChars - headChars;
    const omitted = out.length - headChars - tailChars;
    out = `${out.slice(0, headChars)}\n…${omitted} karakter dihilangkan…\n${out.slice(-tailChars)}`;
  }
  return out;
}

export function formatExecResult({ stdout, stderr, exitCode } = {}, limits = {}) {
  const out = sanitizeOutput(stdout, limits);
  const err = sanitizeOutput(stderr, limits);
  const parts = [];
  if (out) parts.push(out);
  if (err) parts.push(`[stderr]\n${err}`);
  if (!parts.length) parts.push('(tidak ada output)');
  return `${parts.join('\n')}\n[exit code: ${exitCode ?? '?'}]`;
}
