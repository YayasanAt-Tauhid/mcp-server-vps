import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createBrowserGateway} from './browser-gateway.js';

const fixtureSigningValue = 'x'.repeat(64);
async function withServer(callback) {
  const app = express();
  const server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const origin='http://127.0.0.1:'+server.address().port;
  const config = {baseUrl:origin};
  config['secret'] = fixtureSigningValue; // synthetic fixture only
  const gateway = createBrowserGateway(config);
  gateway.mount(app);
  try { await callback(gateway,origin); } finally {await new Promise(resolve=>server.close(resolve));}
}
test('GET must not consume signed browser login link (link preview safe)',async()=>{
  await withServer(async (gateway,origin)=>{
    const url=gateway.issueLink();
    const first=await fetch(url,{redirect:'manual'});
    const second=await fetch(url,{redirect:'manual'});
    assert.equal(first.status,200);
    assert.equal(second.status,200);
    assert.match(await first.text(),/Lanjutkan ke browser Safara/);
    assert.equal(first.headers.get('set-cookie'),null);
    assert.equal(second.headers.get('set-cookie'),null);
    const post=await fetch(url,{method:'POST',headers:{Origin:origin},redirect:'manual'});
    assert.equal(post.status,303);
    assert.match(post.headers.get('set-cookie')||'',/HttpOnly/);
    const replay=await fetch(url,{method:'POST',headers:{Origin:origin},redirect:'manual'});
    assert.equal(replay.status,401);
  });
});
test('cross-site POST rejected even with a valid signed browser ticket',async()=>{
  await withServer(async (gateway,origin)=>{
    const url=gateway.issueLink();
    const forged=await fetch(url,{method:'POST',headers:{Origin:'https://attacker.test'},redirect:'manual'});
    assert.equal(forged.status,403);
    const legitimate=await fetch(url,{method:'POST',headers:{Origin:origin},redirect:'manual'});
    assert.equal(legitimate.status,303);
  });
});
test('opaque Origin with same-origin Fetch Metadata can confirm once',async()=>{
  await withServer(async gateway=>{
    const url=gateway.issueLink();
    const response=await fetch(url,{method:'POST',headers:{Origin:'null','Sec-Fetch-Site':'same-origin'},redirect:'manual'});
    assert.equal(response.status,303);
  });
});
test('opaque Origin with cross-site Fetch Metadata is rejected',async()=>{
  await withServer(async gateway=>{
    const url=gateway.issueLink();
    const response=await fetch(url,{method:'POST',headers:{Origin:'null','Sec-Fetch-Site':'cross-site'},redirect:'manual'});
    assert.equal(response.status,403);
  });
});
test('invalid or expired link never offers a usable login form',async()=>{
  await withServer(async (gateway,origin)=>{
    const url=new URL(gateway.issueLink());
    url.searchParams.set('expires','1');
    const response=await fetch(url,{redirect:'manual'});
    assert.equal(response.status,401);
    assert.doesNotMatch(await response.text(),/method="post"/);
  });
});
