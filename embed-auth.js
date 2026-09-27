import http from 'node:http';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
const env=readFileSync(new URL('.env',import.meta.url),'utf8');
const password=env.split('\n').find(x=>x.startsWith('APPROVE_PASSWORD='))?.slice(17).trim();
if(!password) throw Error('Missing approval password');
const sessions=new Map(), attempts=new Map();
const signed=(nonce,expires)=>crypto.createHmac('sha256',password).update('browser-view:'+nonce+':'+expires).digest('hex');
const page=(res,status=200,bad=false)=>{
 res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
 res.end('<!doctype html><html lang="id"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;max-width:420px;margin:8vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:12px 0}button{background:#2563eb;color:white;border:0;border-radius:8px}</style><h2>Browser VPS At-Tauhid</h2><p>Masukkan password approval konektor VPS.</p>'+(bad?'<p style="color:#b42318">Password salah atau percobaan dibatasi.</p>':'')+'<form method="post" action="/embed/login"><input type="password" name="password" autocomplete="current-password" required><button>Buka browser</button></form></html>');
};
function valid(req){const token=/(?:^|;\s*)at_browser=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];return !!token && (sessions.get(token)||0)>Date.now();}
function grant(res){
 const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now()+28800000);
 res.writeHead(303,{'Location':'/embed/vnc.html?path=embed/websockify&autoconnect=1','Set-Cookie':'at_browser='+token+'; Path=/embed; Max-Age=28800; HttpOnly; Secure; SameSite=None; Partitioned','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();
}
http.createServer((req,res)=>{
 const ip=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress);
 if(req.url==='/auth'){res.writeHead(valid(req)?204:401,{'Cache-Control':'no-store'});return res.end();}
 const url=new URL(req.url||'/', 'https://browser-vps.hijrah-attauhid.or.id');
 if(url.pathname!=='/embed/login'){res.writeHead(404);return res.end();}
 if(req.method==='GET'){
  if(valid(req)){res.writeHead(302,{'Location':'/embed/vnc.html?path=embed/websockify&autoconnect=1','Cache-Control':'no-store'});return res.end();}
  const nonce=url.searchParams.get('nonce')||'', expires=Number(url.searchParams.get('expires')), sig=url.searchParams.get('sig')||'';
  if(/^[a-f0-9]{32}$/.test(nonce) && Number.isSafeInteger(expires) && expires>Date.now() && expires<Date.now()+180000 && /^[a-f0-9]{64}$/.test(sig)){
   const expected=signed(nonce,expires);
   if(crypto.timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(expected,'hex')))return grant(res);
  }
  return page(res);
 }
 if(req.method!=='POST'){res.writeHead(405);return res.end();}
 if(req.headers.origin && req.headers.origin!=='https://browser-vps.hijrah-attauhid.or.id'){res.writeHead(403);return res.end();}
 let body='';req.on('data',x=>{body+=x;if(body.length>4096)req.destroy()});req.on('end',()=>{
  const rec=attempts.get(ip)||{count:0,until:0};
  if(rec.until>Date.now())return page(res,429,true);
  const a=Buffer.from(new URLSearchParams(body).get('password')||''),b=Buffer.from(password);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){rec.count++;if(rec.count>=5){rec.until=Date.now()+900000;rec.count=0;}attempts.set(ip,rec);return page(res,401,true);}
  attempts.delete(ip);grant(res);
 });
}).listen(6082,'127.0.0.1');
