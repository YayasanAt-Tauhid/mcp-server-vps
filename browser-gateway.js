import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { browserSetMode } from './browser-tools.js';

export function createBrowserAccess(secret, now = Date.now) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('Browser access requires a strong configured approval secret');
  const sessions = new Map(), usedLinks = new Map();
  const sign = (nonce, expires) => crypto.createHmac('sha256', secret).update('shared-browser:' + nonce + ':' + expires).digest('hex');
  const prune = () => {
    for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key);
    for (const [key, expires] of usedLinks) if (expires <= now()) usedLinks.delete(key);
  };
  const linkStatus = (url) => {
    const nonce = url.searchParams.get('nonce') || '', sig = url.searchParams.get('sig') || '';
    const expires = Number(url.searchParams.get('expires'));
    if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig) ||
        !Number.isSafeInteger(expires)) return 'malformed';
    if (expires <= now()) return 'expired';
    if (expires > now() + 600000) return 'future';
    if (usedLinks.has(nonce)) return 'replayed';
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(sign(nonce, expires), 'hex'))) return 'bad_signature';
    if (sessions.size >= 1000 || usedLinks.size >= 1000) return 'capacity';
    return 'valid';
  };
  return {
    linkStatus(url) {
      prune();
      return linkStatus(url);
    },
    issueLink(baseUrl) {
      const nonce = crypto.randomBytes(16).toString('hex'), expires = now() + 600000;
      const url = new URL('/browser/login', baseUrl);
      url.search = new URLSearchParams({ nonce, expires: String(expires), sig: sign(nonce, expires) }).toString();
      return url.toString();
    },
    consumeLink(url) {
      prune();
      if (linkStatus(url) !== 'valid') return null;
      const nonce = url.searchParams.get('nonce');
      const expires = Number(url.searchParams.get('expires'));
      usedLinks.set(nonce, expires);
      const token = crypto.randomBytes(32).toString('hex'), sessionExpires = now() + 28800000;
      sessions.set(token, sessionExpires);
      return { token, expires: sessionExpires };
    },
    session(cookie = '') {
      const token = /(?:^|;\s*)safara_browser=([a-f0-9]{64})(?:;|$)/.exec(cookie)?.[1];
      const expires = token && sessions.get(token);
      return expires && expires > now() ? { token, expires } : null;
    }
  };
}

// Only the explicitly trusted ChatGPT UI ancestors can embed a signed-in browser.
// The browser itself remains session-protected and all state-changing routes
// enforce same-origin requests.
const EMBED_ANCESTORS = "'self' https://chatgpt.com https://chat.openai.com https://*.web-sandbox.oaiusercontent.com";

const viewerHtml = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser Bersama Safara</title><style>body{margin:0;background:#101827;color:#eef3ff;font:14px system-ui}header{height:56px;display:flex;align-items:center;gap:10px;padding:0 16px}strong{margin-right:auto}button{padding:9px 13px;border:1px solid #506080;border-radius:8px;background:#23334d;color:white;cursor:pointer}button[aria-pressed=true]{background:#315fe8}iframe{display:block;border:0;width:100%;height:calc(100dvh - 86px)}footer{height:30px;text-align:center;color:#b9c7df;font-size:12px}#status{margin-left:8px}</style>
<header><strong>Browser Safara</strong><button data-mode="desktop">Desktop</button><button data-mode="mobile">Mobile</button><button id="full">Layar penuh</button></header>
<iframe title="Browser bersama" src="/browser/vnc.html?autoconnect=1&amp;resize=scale&amp;path=/browser/websockify"></iframe>
<footer>Anda dapat memasukkan login langsung di browser ini.<span id="status" role="status"></span></footer>
<script>
const status=document.getElementById('status');
for(const b of document.querySelectorAll('[data-mode]'))b.onclick=async()=>{
  status.textContent='Mengubah tampilan…';
  try{const r=await fetch('/browser/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:b.dataset.mode})});
  if(!r.ok)throw Error();for(const x of document.querySelectorAll('[data-mode]'))x.setAttribute('aria-pressed',String(x===b));status.textContent='';}
  catch{status.textContent='Sesi berakhir atau browser belum siap. Buka ulang dari ChatGPT.';}
};
document.getElementById('full').onclick=()=>document.documentElement.requestFullscreen?.();
</script></html>`;

export function createBrowserGateway({baseUrl, secret, novncRoot = '/usr/share/novnc', port = 6080}) {
  const origin = new URL(baseUrl).origin, access = createBrowserAccess(secret);
  function rejectSocket(socket, status = 401) {
    socket.end('HTTP/1.1 ' + status + ' Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
  return {
    issueLink: () => access.issueLink(baseUrl),
    mount(app) {
      app.use('/browser', (req, res, next) => {
        res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
        next();
      });
      const invalidLogin = (req, res, status) => {
        // Never log nonce, signature, query string, cookies or user identity.
        console.warn('[BROWSER] rejected login ticket:', status);
        return res.status(401).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><p>Tautan tidak valid atau kedaluwarsa. Buka kartu browser Safara terbaru di ChatGPT; jangan gunakan tab atau tautan yang tersimpan sebelumnya.</p>');
      };
      app.get('/browser/login', (req, res) => {
        if (access.session(req.headers.cookie)) return res.redirect(303, '/browser/view');
        const status = access.linkStatus(new URL(req.originalUrl, baseUrl));
        if (status !== 'valid') return invalidLogin(req, res, status);
        // A preview/prefetch GET must never consume the signed, one-use link.
        res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors " + EMBED_ANCESTORS);
        return res.type('html').send('<!doctype html><html lang="id"><meta name="viewport" content="width=device-width"><meta charset="utf-8"><title>Masuk Browser Safara</title><style>body{max-width:32rem;margin:12vh auto;padding:1.5rem;font:16px system-ui}button{padding:1rem 1.5rem;border-radius:9px;border:0;background:#2357c6;color:white;font:inherit}</style><h2>Browser Safara</h2><p>Tautan berhasil diperiksa. Tekan tombol untuk membuat sesi browser yang aman.</p><form method="post"><button type="submit">Lanjutkan ke browser Safara</button></form><p>Jangan bagikan tautan sesi ini.</p></html>');
      });
      app.post('/browser/login', (req, res) => {
        if (access.session(req.headers.cookie)) return res.redirect(303, '/browser/view');
        const site = req.headers['sec-fetch-site'];
        const originHeader = req.headers.origin;
        // Referrer-Policy:no-referrer can make Chromium submit Origin:null.
        // Only accept that opaque value if the browser ALSO asserts same-origin.
        const acceptedOrigin = !originHeader || originHeader === origin ||
          (originHeader === 'null' && site === 'same-origin');
        if (!acceptedOrigin || site === 'cross-site') {
          console.warn('[BROWSER] rejected cross-origin confirmation:',
            site === 'cross-site' ? 'cross_site_fetch' : 'origin_mismatch');
          return res.sendStatus(403);
        }
        const link = new URL(req.originalUrl, baseUrl);
        const session = access.consumeLink(link);
        if (!session) return invalidLogin(req, res, access.linkStatus(link));
        res.set('Set-Cookie','safara_browser=' + session.token + '; Path=/browser; Max-Age=28800; HttpOnly; Secure; SameSite=None; Partitioned');
        return res.redirect(303, '/browser/view');
      });
      app.use('/browser', (req, res, next) => {
        if (!access.session(req.headers.cookie)) return res.status(401).send('Browser session required. Open browser_view in ChatGPT.');
        next();
      });
      app.get('/browser/view', (req,res) => {
        res.set('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors " + EMBED_ANCESTORS + "; base-uri 'none'");
        res.type('html').send(viewerHtml);
      });
      app.post('/browser/mode', async (req,res) => {
        if (req.headers.origin !== origin) return res.sendStatus(403);
        if (!['desktop','mobile'].includes(req.body?.mode)) return res.sendStatus(400);
        try { const result=await browserSetMode({mode:req.body.mode});res.json({mode:result.mode,viewport:result.viewport}); }
        catch { res.status(503).json({error:'browser_unavailable'}); }
      });
      app.use('/browser', express.static(novncRoot, {index:false,dotfiles:'deny',fallthrough:false}));
    },
    upgrade(req, socket, head) {
      if (req.url !== '/browser/websockify') return socket.destroy();
      const session = access.session(req.headers.cookie);
      if (!session) return rejectSocket(socket);
      if (req.headers.origin !== origin) return rejectSocket(socket,403);
      const proxy = http.request({hostname:'127.0.0.1',port,path:'/websockify',method:'GET',headers:{
        host:'127.0.0.1:'+port,connection:'Upgrade',upgrade:'websocket',
        'sec-websocket-key':req.headers['sec-websocket-key'],
        'sec-websocket-version':req.headers['sec-websocket-version'],
        ...(req.headers['sec-websocket-protocol'] ? {'sec-websocket-protocol':req.headers['sec-websocket-protocol']} : {})
      }});
      proxy.setTimeout(5000,()=>proxy.destroy());
      proxy.on('upgrade',(response, upstream, upstreamHead)=>{
        proxy.setTimeout(0);
        let header='HTTP/1.1 101 Switching Protocols\r\n';
        for(let i=0;i<response.rawHeaders.length;i+=2)header+=response.rawHeaders[i]+': '+response.rawHeaders[i+1]+'\r\n';
        socket.write(header+'\r\n');
        if(upstreamHead.length)socket.write(upstreamHead);
        if(head.length)upstream.write(head);
        const expiry=setTimeout(()=>{socket.destroy();upstream.destroy();},Math.max(1,session.expires-Date.now()));expiry.unref();
        socket.on('close',()=>{clearTimeout(expiry);upstream.destroy()});
        upstream.on('close',()=>{clearTimeout(expiry);socket.destroy()});
        socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
        upstream.pipe(socket);socket.pipe(upstream);
      });
      proxy.on('response',()=>socket.destroy());
      proxy.on('error',()=>socket.destroy());
      socket.on('error',()=>proxy.destroy());
      proxy.end();
    }
  };
}
