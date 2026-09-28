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
  return {
    issueLink(baseUrl) {
      const nonce = crypto.randomBytes(16).toString('hex'), expires = now() + 600000;
      const url = new URL('/browser/login', baseUrl);
      url.search = new URLSearchParams({ nonce, expires: String(expires), sig: sign(nonce, expires) }).toString();
      return url.toString();
    },
    consumeLink(url) {
      prune();
      const nonce = url.searchParams.get('nonce') || '', sig = url.searchParams.get('sig') || '', expires = Number(url.searchParams.get('expires'));
      if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig) || !Number.isSafeInteger(expires) ||
          expires <= now() || expires > now() + 600000 || usedLinks.has(nonce)) return null;
      if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(sign(nonce, expires), 'hex'))) return null;
      if (sessions.size >= 1000 || usedLinks.size >= 1000) return null;
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
      app.get('/browser/login', (req, res) => {
        if (access.session(req.headers.cookie)) return res.redirect(303, '/browser/view');
        const session = access.consumeLink(new URL(req.originalUrl, baseUrl));
        if (!session) return res.status(401).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><p>Tautan tidak valid atau kedaluwarsa. Minta ChatGPT membuka browser Safara kembali.</p>');
        res.set('Set-Cookie','safara_browser=' + session.token + '; Path=/browser; Max-Age=28800; HttpOnly; Secure; SameSite=Lax');
        return res.redirect(303, '/browser/view');
      });
      app.use('/browser', (req, res, next) => {
        if (!access.session(req.headers.cookie)) return res.status(401).send('Browser session required. Open browser_view in ChatGPT.');
        next();
      });
      app.get('/browser/view', (req,res) => {
        res.set('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'");
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
