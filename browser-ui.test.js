import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./browser-ui.html', import.meta.url), 'utf8');
const origin = 'https://mcp.example.test';

function setup({popupBlocked = false, popupThrows = false, urlForCall = (n) => origin + '/browser/login?sig=fixture-' + n} = {}) {
  const callbacks = new Map(), opened = [], closed = [], fallbacks = [];
  const button = { disabled: false, addEventListener(event, callback) { callbacks.set(event, callback); } };
  const fallback = { hidden: true, href: '', removeAttribute(name) { if (name === 'href') this.href = ''; } };
  const status = { textContent: '' };
  let calls = 0;
  const window = {
    open() {
      if (popupThrows) throw new Error('Popup blocked by sandbox');
      if (popupBlocked) return null;
      const popup = {
        closed: false, opener: {},
        location: { replace(url) { opened.push(url); } },
        close() { closed.push(true); this.closed = true; }
      };
      return popup;
    },
    openai: {
      async callTool(name, args) {
        assert.equal(name, 'browser_get_view_url');
        assert.equal(Object.keys(args).length, 0);
        return { structuredContent: { url: urlForCall(++calls) } };
      }
    }
  };
  const document = { getElementById(id) {
    const elements = { 'open-browser': button, 'fallback-link': fallback, 'view-status': status };
    if (!(id in elements)) throw Error('Unexpected DOM ID: ' + id);
    return elements[id];
  }};
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const script = scripts[0][1].replace('__BROWSER_ORIGIN__', JSON.stringify(origin));
  vm.runInNewContext(script, { window, document, URL });
  return {
    async click() { await callbacks.get('click')(); },
    button, fallback, status, opened, closed, fallbacks,
    get calls() { return calls; }
  };
}

test('browser card never caches a one-time login URL in the HTML resource', () => {
  assert.doesNotMatch(html, /__BROWSER_VIEW_URL__/);
  assert.match(html, /browser_get_view_url/);
  assert.match(html, /id="open-browser"/);
});

test('each browser opening requests a new link even when same card is reused', async () => {
  const ui = setup();
  await ui.click();
  await ui.click();
  assert.equal(ui.calls, 2);
  assert.deepEqual(ui.opened, [
    origin + '/browser/login?sig=fixture-1',
    origin + '/browser/login?sig=fixture-2'
  ]);
  assert.equal(ui.button.disabled, false);
});

test('popup-blocked viewer offers newly signed link to click directly', async () => {
  const ui = setup({ popupBlocked: true });
  await ui.click();
  assert.equal(ui.calls, 1);
  assert.equal(ui.fallback.hidden, false);
  assert.equal(ui.fallback.href, origin + '/browser/login?sig=fixture-1');
});

test('sandbox popup exception still produces a fresh fallback link', async () => {
  const ui = setup({ popupThrows: true });
  await ui.click();
  assert.equal(ui.calls, 1);
  assert.equal(ui.fallback.hidden, false);
  assert.equal(ui.fallback.href, origin + '/browser/login?sig=fixture-1');
});

test('browser card rejects a login link on another origin', async () => {
  const ui = setup({urlForCall: () => 'https://untrusted.example/browser/login'});
  await ui.click();
  assert.equal(ui.opened.length, 0);
  assert.equal(ui.closed.length, 1);
  assert.equal(ui.button.disabled, false);
  assert.match(ui.status.textContent, /tidak dapat/i);
});
