import crypto from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const LOGIN_TTL_MS = 120000;
export const claudeAppDomain = url => crypto.createHash('sha256').update(url).digest('hex').slice(0, 32) + '.claudemcpcontent.com';

export function embedAncestors(baseUrl = 'https://mcp-vps2.hijrah-attauhid.or.id', extra = '') {
  const base = baseUrl.replace(/\/$/, '');
  const origins = ["'self'", 'https://chatgpt.com', 'https://chat.openai.com',
    'https://*.web-sandbox.oaiusercontent.com', 'https://claude.ai',
    ...[base, base + '/', base + '/sse'].map(url => 'https://' + claudeAppDomain(url))];
  for (const value of extra.split(/[\s,]+/).filter(Boolean)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw Error('Embed origins must be exact HTTPS origins');
    origins.push(value);
  }
  return [...new Set(origins)];
}

export function createLoginTickets({ key, stateFile, now = Date.now }) {
  let used = {};
  if (stateFile) {
    try { used = JSON.parse(readFileSync(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {
    consume(nonce, expires, signature) {
      const time = now();
      if (!/^[a-f0-9]{32}$/.test(nonce) || !Number.isSafeInteger(expires) || expires <= time ||
          expires > time + LOGIN_TTL_MS + 10000 || !/^[a-f0-9]{64}$/.test(signature)) return false;
      const expected = crypto.createHmac('sha256', key).update('browser-view:' + nonce + ':' + expires).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return false;
      for (const [id, expiry] of Object.entries(used)) if (expiry <= time) delete used[id];
      if (used[nonce] || Object.keys(used).length >= 4096) return false;
      used[nonce] = expires;
      if (stateFile) {
        writeFileSync(stateFile + '.tmp', JSON.stringify(used), { mode: 0o600 });
        renameSync(stateFile + '.tmp', stateFile);
      }
      return true;
    }
  };
}
