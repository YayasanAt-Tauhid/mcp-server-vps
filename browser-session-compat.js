// URL handling is deliberately independent of host integration so we can unit-test
// fallback links without ever disclosing a real signed browser ticket.
export function safeBrowserViewUrl(value, origin, now = Date.now()) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.pathname !== '/browser/login' || url.username || url.password || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 3 || !['nonce','expires','sig'].every(key => keys.filter(item => item === key).length === 1)) return null;
    const nonce = url.searchParams.get('nonce');
    const signature = url.searchParams.get('sig');
    const expires = url.searchParams.get('expires');
    if (!/^[a-f0-9]{32}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(signature || '') ||
        !/^\d{13}$/.test(expires || '')) return null;
    const expiry = Number(expires);
    if (!Number.isSafeInteger(expiry) || expiry <= now) return null;
    // The server independently validates the signature, short lifetime, and single use.
    return url.href;
  } catch { return null; }
}
export function extractBrowserViewUrl(value, origin, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  const direct = safeBrowserViewUrl(value.browserViewUrl, origin) ||
    safeBrowserViewUrl(value._meta?.browserViewUrl, origin) ||
    safeBrowserViewUrl(value.structuredContent?.url, origin);
  if (direct) return direct;
  for (const key of ['result', 'params', 'toolOutput', 'toolResponseMetadata', 'mcp_tool_result', 'call_tool_result']) {
    const found = extractBrowserViewUrl(value[key], origin, depth + 1);
    if (found) return found;
  }
  return null;
}
