import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ORIGIN = 'https://mcp.safara.biz.id';
const expires = String(Date.now() + 300000);
const link = ORIGIN+'/browser/login?nonce='+'1'.repeat(32)+'&expires='+expires+'&sig='+'a'.repeat(64);
const html = readFileSync(new URL('./browser-ui.html', import.meta.url),'utf8')
  .replace('__BROWSER_ORIGIN__',JSON.stringify(ORIGIN));

// Mocked host metadata; no real ticket is used and no request reaches the Safara MCP.
async function browserWithResult(result) {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  await page.addInitScript(arg => {
    window.openai = {toolResponseMetadata:arg};
  }, result);
  await page.route('https://test-panel.invalid/**', route => route.fulfill({status:200,contentType:'text/html',body:html}));
  await page.route(ORIGIN+'/**', route => route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Mock login confirmation</title>'}));
  await page.goto('https://test-panel.invalid/app');
  return {browser,page};
}

test('Safara panel loads iframe from signed tool result metadata even if host bridge does not connect',async()=>{
  const {browser,page}=await browserWithResult({browserViewUrl:link});
  try{
    await page.waitForFunction(expected=>document.querySelector('#browser')?.src===expected,link,{timeout:5000});
    assert.equal(await page.locator('#empty').isHidden(),true);
    assert.match(await page.locator('#status').innerText(),/Konfirmasikan sesi Safara/);
  }finally{await browser.close();}
});

test('Safara panel never loads untrusted ticket from host metadata',async()=>{
  const {browser,page}=await browserWithResult({browserViewUrl:link.replace(ORIGIN,'https://attacker.invalid')});
  try {
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#browser').getAttribute('src'),null);
    assert.equal(await page.locator('#empty').isVisible(),true);
  }finally{await browser.close();}
});
