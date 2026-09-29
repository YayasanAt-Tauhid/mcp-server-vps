import http from 'node:http';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {browserSetMode, browserCurrentMode, browserCurrentDisplay} from './browser-tools.js';
import {createWebSocketTickets} from './browser-websocket-auth.js';
import {createLoginTickets, embedAncestors} from './browser-embed-security.js';

const env=readFileSync(process.env.BROWSER_EMBED_ENV_FILE || new URL('.env',import.meta.url),'utf8');
const browserOrigin=process.env.BROWSER_EMBED_ORIGIN || 'https://browser-vps.hijrah-attauhid.or.id';
const ancestors=embedAncestors(process.env.BASE_URL, process.env.BROWSER_EMBED_ANCESTORS || '');
const browserViewer=readFileSync(new URL('browser-viewer.html',import.meta.url),'utf8').replace('/*__ALLOWED_PARENTS__*/[]',JSON.stringify(ancestors));
const password=env.split('\n').find(x=>x.startsWith('APPROVE_PASSWORD='))?.slice(17).trim();
if(!password) throw Error('Missing approval password');

const sessions=new Map(), attempts=new Map();
const websocketTickets=createWebSocketTickets({sessions,origin:browserOrigin});
const loginTickets=createLoginTickets({key:password,stateFile:process.env.BROWSER_LOGIN_NONCE_FILE || '/tmp/attauhid-browser-login-nonces.json'});

const loginPage=(res,status=200,bad=false)=>{
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  res.end('<!doctype html><html lang="id"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;max-width:420px;margin:8vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:12px 0}button{background:#2563eb;color:white;border:0;border-radius:8px}</style><h2>Browser VPS At-Tauhid</h2><p>Masukkan password approval konektor VPS.</p>'+(bad?'<p style="color:#b42318">Password salah atau percobaan dibatasi.</p>':'')+'<form method="post" action="/embed/login"><input type="password" name="password" autocomplete="current-password" required><button>Buka browser</button></form></html>');
};

const browserPage=(res)=>{
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  res.end(browserViewer);
};

function sessionToken(req){
  return /(?:^|;\s*)at_browser=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
}

function valid(req){
  const token=sessionToken(req);
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
    res.setHeader('Content-Security-Policy', 'frame-ancestors ' + ancestors.join(' '));
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const ip=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress);
    const url=new URL(req.url||'/', browserOrigin);

    if(url.pathname==='/auth'){
      res.writeHead(valid(req)?204:401,{'Cache-Control':'no-store'});
      return res.end();
    }

    if(url.pathname==='/auth/ws'){
      const original=new URL(String(req.headers['x-browser-request-uri']||'/'),browserOrigin);
      const ticket=original.searchParams.get('ticket');
      const allowed=original.pathname==='/embed/websockify'
        && req.headers['x-browser-upgrade']==='websocket'
        && req.headers.origin===browserOrigin
        && (ticket ? websocketTickets.consume(ticket,req.headers.origin) : valid(req));
      res.writeHead(allowed?204:401,{'Cache-Control':'no-store'});
      return res.end();
    }

    if(url.pathname==='/connection'){
      if(!valid(req)) return json(res,401,{error:'unauthorized'});
      if(req.method!=='POST'){
        res.writeHead(405,{'Allow':'POST','Cache-Control':'no-store'});
        return res.end();
      }
      if(req.headers.origin!==browserOrigin) return json(res,403,{error:'origin'});
      const {ticket,expiresAt}=websocketTickets.issue(sessionToken(req));
      return json(res,200,{path:'embed/websockify?ticket='+ticket,expiresAt});
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
      if(req.method==='GET') return json(res,200,browserCurrentDisplay());
      if(req.method!=='POST'){
        res.writeHead(405,{'Allow':'GET, POST'});
        return res.end();
      }
      if(req.headers.origin && req.headers.origin!==browserOrigin){
        return json(res,403,{error:'origin'});
      }
      const raw=await readBody(req,1024);
      let mode='', dimensions={};
      try{
        const type=String(req.headers['content-type']||'');
        dimensions=type.includes('application/json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw));
        mode=dimensions.mode;
      }catch{}
      if(!['desktop','mobile'].includes(mode)) return json(res,400,{error:'invalid_mode'});
      const result=await browserSetMode({mode,width:dimensions.width,height:dimensions.height});
      return json(res,200,{mode:result.mode,width:result.target.width,height:result.target.height,viewport:result.viewport});
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
      if(loginTickets.consume(nonce,expires,sig)) return grant(res);
      return loginPage(res);
    }

    if(req.method!=='POST'){
      res.writeHead(405);
      return res.end();
    }

    if(req.headers.origin && req.headers.origin!==browserOrigin){
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
}).listen(Number(process.env.BROWSER_EMBED_AUTH_PORT || 6082),'127.0.0.1');
