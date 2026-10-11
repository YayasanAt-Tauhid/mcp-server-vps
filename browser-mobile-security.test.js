import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { displayConfig, parseDisplayState } from './browser-display.js';
import { createLoginTickets, embedAncestors, claudeAppDomain } from './browser-embed-security.js';

test('mobile sizes match the visible panel and stay inside the physical framebuffer', () => {
  assert.deepEqual([displayConfig('mobile', {width:360,height:654}).width,displayConfig('mobile', {width:360,height:654}).height],[360,654]);
  assert.equal(displayConfig('mobile',{width:900,height:2000}).height,768);
  assert.equal(displayConfig('mobile',{width:900}).width,640);
  assert.equal(displayConfig('mobile',{width:100}).width,320);
  assert.throws(()=>displayConfig('mobile',{width:'NaN'}));
  assert.equal(parseDisplayState('mobile\n').mode,'mobile');
  assert.equal(parseDisplayState('{"mode":"mobile","width":360,"height":640}').width,360);
});

test('embed allowlist includes specific Claude app origins and rejects unrestricted additions', () => {
  const list=embedAncestors();
  assert.ok(list.includes('https://claude.ai'));
  assert.ok(list.includes('https://'+claudeAppDomain('https://mcp-vps2.hijrah-attauhid.or.id')));
  assert.ok(!list.includes('*')&&!list.includes('https://*.claudemcpcontent.com'));
  for(const extra of ['*','https://*.example.com','http://example.com','https://example.com/path','https://example.com;']) assert.throws(()=>embedAncestors(undefined,extra));
});

test('signed login is one-use, expires, rejects tampering and remains consumed after restart', () => {
  let now=1000000;
  const key='test-only-key';
  const temp=mkdtempSync(join(tmpdir(),'browser-login-test-'));
  const stateFile=join(temp,'nonces.json');
  const make=()=>createLoginTickets({key,stateFile,now:()=>now});
  const sign=(n,e)=>crypto.createHmac('sha256',key).update('browser-view:'+n+':'+e).digest('hex');
  try {
    const nonce='a'.repeat(32), expires=now+120000, sig=sign(nonce,expires);
    const tickets=make();
    assert.equal(tickets.consume(nonce,expires,'f'.repeat(64)),false);
    assert.equal(tickets.consume(nonce,expires,sig),true);
    assert.equal(tickets.consume(nonce,expires,sig),false);
    assert.equal(make().consume(nonce,expires,sig),false);
    assert.equal(make().consume('b'.repeat(32),now+600000,sign('b'.repeat(32),now+600000)),false);
    now=expires;
    assert.equal(make().consume(nonce,expires,sig),false);
  } finally {rmSync(temp,{recursive:true,force:true});}
});
