import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserAccess} from './browser-gateway.js';
const secret='browser-unit-test-secret-not-for-deployment';
test('browser links issue scoped sessions and cannot be replayed',()=>{
  let now=1000000;const access=createBrowserAccess(secret,()=>now);
  const url=new URL(access.issueLink('https://mcp.example.test'));
  assert.equal(url.pathname,'/browser/login');
  const session=access.consumeLink(url);assert(session);
  assert(access.session('other=x; safara_browser='+session.token));
  assert.equal(access.consumeLink(url),null);
  assert.equal(access.session('safara_browser=bad'),null);
  now+=28800001;assert.equal(access.session('safara_browser='+session.token),null);
});
test('browser links reject tampering, expiry, malformed input and wrong signer',()=>{
  let now=1000000;const access=createBrowserAccess(secret,()=>now);
  const link=access.issueLink('https://mcp.example.test');
  const tampered=new URL(link);tampered.searchParams.set('expires','999999999');assert.equal(access.consumeLink(tampered),null);
  const wrong=new URL(link);wrong.searchParams.set('sig','a'.repeat(64));assert.equal(access.consumeLink(wrong),null);
  assert.equal(createBrowserAccess(secret+'other',()=>now).consumeLink(new URL(link)),null);
  assert.equal(access.consumeLink(new URL('https://mcp.example.test/browser/login')),null);
  now+=600001;assert.equal(access.consumeLink(new URL(link)),null);
});
test('browser signer fails closed without configured secret',()=>{
  assert.throws(()=>createBrowserAccess(''));assert.throws(()=>createBrowserAccess('short'));
});
