import http from 'node:http';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {browserSetMode, browserCurrentMode} from './browser-tools.js';

const env=readFileSync(new URL('.env',import.meta.url),'utf8');
const password=env.split('\n').find(x=>x.startsWith('APPROVE_PASSWORD='))?.slice(17).trim();
if(!password) throw Error('Missing approval password');

const sessions=new Map(), attempts=new Map();
const signed=(nonce,expires)=>crypto.createHmac('sha256',password).update('browser-view:'+nonce+':'+expires).digest('hex');

const loginPage=(res,status=200,bad=false)=>{
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  res.end('<!doctype html><html lang="id"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;max-width:420px;margin:8vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:12px 0}button{background:#2563eb;color:white;border:0;border-radius:8px}</style><h2>Browser VPS At-Tauhid</h2><p>Masukkan password approval konektor VPS.</p>'+(bad?'<p style="color:#b42318">Password salah atau percobaan dibatasi.</p>':'')+'<form method="post" action="/embed/login"><input type="password" name="password" autocomplete="current-password" required><button>Buka browser</button></form></html>');
};

const browserPage=(res)=>{
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  res.end(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser VPS At-Tauhid</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#111827;color:#f8fafc;font:14px system-ui,sans-serif;overflow:hidden}
.toolbar{height:52px;display:flex;align-items:center;gap:8px;padding:7px 10px;background:#1f2937;border-bottom:1px solid #374151}
.brand{font-weight:700;white-space:nowrap;margin-right:4px}
.spacer{flex:1}
.status{font-size:12px;opacity:.8;white-space:nowrap}
button{border:1px solid #4b5563;background:#273449;color:#f8fafc;border-radius:9px;padding:7px 10px;font:inherit;cursor:pointer}
button:hover{background:#334155}
button.active{background:#e2e8f0;color:#0f172a;border-color:#e2e8f0}
button:disabled{opacity:.5;cursor:wait}
.stage{height:calc(100% - 52px);display:flex;justify-content:center;background:#0b1020}
.frame-wrap{width:100%;height:100%;transition:max-width .2s ease,width .2s ease}
.stage.mobile .frame-wrap{max-width:430px}
iframe{display:block;width:100%;height:100%;border:0;background:#0f172a}
@media(max-width:700px){
 .brand{display:none}
 .toolbar{gap:5px;padding:6px}
 .status{display:none}
 button{padding:7px 8px;font-size:12px}
}
</style>
</head>
<body>
<div class="toolbar">
  <span class="brand">Browser VPS At-Tauhid</span>
  <button id="desktop" type="button">🖥 Desktop</button>
  <button id="mobile" type="button">📱 Mobile</button>
  <span class="spacer"></span>
  <span id="status" class="status">Memuat mode…</span>
  <button id="fullscreen" type="button" title="Fullscreen">⛶ Fullscreen</button>
</div>
<div id="stage" class="stage">
  <div class="frame-wrap">
    <iframe id="vnc" src="/embed/vnc.html?path=embed/websockify&autoconnect=1&resize=scale" allow="fullscreen"></iframe>
  </div>
</div>
<script>
const desktop=document.getElementById('desktop');
const mobile=document.getElementById('mobile');
const fullscreen=document.getElementById('fullscreen');
const stage=document.getElementById('stage');
const status=document.getElementById('status');

function paint(mode){
  desktop.classList.toggle('active',mode==='desktop');
  mobile.classList.toggle('active',mode==='mobile');
  stage.classList.toggle('mobile',mode==='mobile');
  status.textContent=mode==='mobile'?'Mobile · 390×844':'Desktop · 1366×768';
}
async function refresh(){
  try{
    const r=await fetch('/embed/mode',{cache:'no-store'});
    const j=await r.json();
    paint(j.mode||'desktop');
  }catch{paint('desktop')}
}
async function change(mode){
  desktop.disabled=true; mobile.disabled=true;
  status.textContent=mode==='mobile'?'Mengaktifkan mobile…':'Mengaktifkan desktop…';
  try{
    const r=await fetch('/embed/mode',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode})
    });
    if(!r.ok) throw new Error('Mode gagal');
    const j=await r.json();
    paint(j.mode||mode);
  }catch(e){
    status.textContent='Gagal mengubah mode';
  }finally{
    desktop.disabled=false; mobile.disabled=false;
  }
}
desktop.addEventListener('click',()=>change('desktop'));
mobile.addEventListener('click',()=>change('mobile'));
fullscreen.addEventListener('click',async()=>{
  try{
    if(!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  }catch{}
});
document.addEventListener('fullscreenchange',()=>{
  fullscreen.textContent=document.fullscreenElement?'⛶ Keluar':'⛶ Fullscreen';
});
refresh();
</script>
</body>
</html>`);
};

function valid(req){
  const token=/(?:^|;\s*)at_browser=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
  return !!token && (sessions.get(token)||0)>Date.now();
}

function grant(res){
  const token=crypto.randomBytes(32).toString('hex');
  sessions.set(token,Date.now()+28800000);
  res.writeHead(303,{
    'Location':'/embed/view',
    'Set-Cookie':'at_browser='+token+'; Path=/embed; Max-Age=28800; HttpOnly; Secure; SameSite=None; Partitioned',
    'Cache-Control':'no-store',
    'Referrer-Policy':'no-referrer'
  });
  res.end();
}

function json(res,status,data){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
}

function readBody(req,limit=4096){
  return new Promise((resolve,reject)=>{
    let body='';
    req.on('data',chunk=>{
      body+=chunk;
      if(body.length>limit) reject(new Error('Body terlalu besar'));
    });
    req.on('end',()=>resolve(body));
    req.on('error',reject);
  });
}

http.createServer(async(req,res)=>{
  try{
    const ip=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress);
    const url=new URL(req.url||'/', 'https://browser-vps.hijrah-attauhid.or.id');

    if(url.pathname==='/auth'){
      res.writeHead(valid(req)?204:401,{'Cache-Control':'no-store'});
      return res.end();
    }

    if(url.pathname==='/view'){
      if(!valid(req)){
        res.writeHead(302,{'Location':'/embed/login','Cache-Control':'no-store'});
        return res.end();
      }
      return browserPage(res);
    }

    if(url.pathname==='/mode'){
      if(!valid(req)) return json(res,401,{error:'unauthorized'});
      if(req.method==='GET') return json(res,200,{mode:browserCurrentMode()});
      if(req.method!=='POST'){
        res.writeHead(405,{'Allow':'GET, POST'});
        return res.end();
      }
      if(req.headers.origin && req.headers.origin!=='https://browser-vps.hijrah-attauhid.or.id'){
        return json(res,403,{error:'origin'});
      }
      const raw=await readBody(req,1024);
      let mode='';
      try{
        const type=String(req.headers['content-type']||'');
        mode=type.includes('application/json')?JSON.parse(raw).mode:new URLSearchParams(raw).get('mode');
      }catch{}
      if(!['desktop','mobile'].includes(mode)) return json(res,400,{error:'invalid_mode'});
      const result=await browserSetMode({mode});
      return json(res,200,{mode:result.mode,viewport:result.viewport});
    }

    if(url.pathname!=='/embed/login' && url.pathname!=='/login'){
      res.writeHead(404);
      return res.end();
    }

    if(req.method==='GET'){
      if(valid(req)){
        res.writeHead(302,{'Location':'/embed/view','Cache-Control':'no-store'});
        return res.end();
      }
      const nonce=url.searchParams.get('nonce')||'', expires=Number(url.searchParams.get('expires')), sig=url.searchParams.get('sig')||'';
      if(/^[a-f0-9]{32}$/.test(nonce) && Number.isSafeInteger(expires) && expires>Date.now() && expires<Date.now()+660000 && /^[a-f0-9]{64}$/.test(sig)){
        const expected=signed(nonce,expires);
        if(crypto.timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(expected,'hex'))) return grant(res);
      }
      return loginPage(res);
    }

    if(req.method!=='POST'){
      res.writeHead(405);
      return res.end();
    }

    if(req.headers.origin && req.headers.origin!=='https://browser-vps.hijrah-attauhid.or.id'){
      res.writeHead(403);
      return res.end();
    }

    const body=await readBody(req);
    const rec=attempts.get(ip)||{count:0,until:0};
    if(rec.until>Date.now()) return loginPage(res,429,true);
    const a=Buffer.from(new URLSearchParams(body).get('password')||''), b=Buffer.from(password);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){
      rec.count++;
      if(rec.count>=5){rec.until=Date.now()+900000;rec.count=0}
      attempts.set(ip,rec);
      return loginPage(res,401,true);
    }
    attempts.delete(ip);
    return grant(res);
  }catch(err){
    console.error('[embed-auth]',err);
    if(!res.headersSent) json(res,500,{error:'internal_error'});
    else res.end();
  }
}).listen(6082,'127.0.0.1');
