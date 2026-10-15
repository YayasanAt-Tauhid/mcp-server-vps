import { readFileSync } from 'node:fs';
import {ListResourcesRequestSchema,ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {
  browserOpen, browserSnapshot, browserClick, browserType, browserSelect,
  browserWait, browserScreenshot, browserTabs, browserBack, browserReload, browserSetMode
} from './browser-tools.js';


const BROWSER_UI_URI='ui://safara/browser-card-v2.html';
const BROWSER_UI_URI_RE=/^ui:\/\/safara\/browser-card-v2\.html$/;
export const sharedBrowserTools=[{
        name: 'browser_view',
        description: 'Tampilkan browser bersama Safara sebagai panel interaktif di ChatGPT. Pengguna dapat memasukkan login langsung di panel.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
          type: 'object',
          properties: { ready: { type: 'boolean' } },
          required: ['ready'],
          additionalProperties: false
        },
        _meta: {
          ui: { resourceUri: BROWSER_UI_URI, visibility: ['model', 'app'] },
          'ui/resourceUri': BROWSER_UI_URI,
          'openai/outputTemplate': BROWSER_UI_URI,
          'openai/widgetAccessible': true,
          'openai/toolInvocation/invoking': 'Membuka browser VPS…',
          'openai/toolInvocation/invoked': 'Browser VPS siap'
        }
      },
      {
        name: 'browser_get_view_url',
        description: 'Ambil URL sesi browser sementara untuk panel MCP App. Tool ini hanya untuk dipanggil UI browser, bukan model.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            expiresAt: { type: 'number' }
          },
          required: ['url', 'expiresAt'],
          additionalProperties: false
        },
        _meta: {
          ui: { visibility: ['app'] },
          'openai/widgetAccessible': true
        }
      },
      {
        name: 'browser_set_mode',
        description: 'Ubah tampilan browser bersama antara desktop dan mobile. Mode mobile memakai emulasi viewport/touch browser sebenarnya, bukan sekadar memperkecil iframe.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['desktop','mobile'], description: 'Mode viewport browser' },
            tabIndex: { type: 'number', description: 'Tab tujuan; default tab aktif' }
          },
          required: ['mode']
        },
        _meta: {
          ui: { visibility: ['model', 'app'] },
          'openai/widgetAccessible': true,
          'openai/toolInvocation/invoking': 'Mengubah mode browser…',
          'openai/toolInvocation/invoked': 'Mode browser diubah'
        }
      },
      {
        name: 'browser_open',
        description: 'Buka URL http/https pada Chromium bersama di Safara. Browser memakai profil persisten yang juga dapat dilihat pengguna melalui noVNC.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL http/https yang akan dibuka' },
            tabIndex: { type: 'number', description: 'Tab tujuan; default tab aktif' },
            timeoutMs: { type: 'number', description: 'Timeout navigasi, default 15000 ms' },
            settleMs: { type: 'number', description: 'Jeda setelah navigasi sebelum hasil dikembalikan' }
          },
          required: ['url']
        }
      },
      {
        name: 'browser_snapshot',
        description: 'Baca kondisi halaman dan elemen interaktif dari browser bersama. Tidak mengembalikan nilai field input/password. Setiap elemen mendapat ref e0, e1, dst untuk click/type/select.',
        inputSchema: {
          type: 'object',
          properties: {
            tabIndex: { type: 'number', description: 'Tab yang dibaca; default tab aktif' },
            limit: { type: 'number', description: 'Batas elemen interaktif, default 120 maksimum 250' }
          }
        }
      },
      {
        name: 'browser_click',
        description: 'Klik elemen browser menggunakan ref dari browser_snapshot, CSS selector, atau teks.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Ref elemen, mis. e3' },
            selector: { type: 'string', description: 'CSS selector alternatif' },
            text: { type: 'string', description: 'Teks elemen alternatif' },
            exact: { type: 'boolean', description: 'Pencocokan text exact, default true' },
            tabIndex: { type: 'number' },
            timeoutMs: { type: 'number' },
            settleMs: { type: 'number' }
          }
        }
      },
      {
        name: 'browser_type',
        description: 'Isi field non-sensitif pada browser bersama. Tool menolak field password, OTP, token, PIN, 2FA/MFA, atau field yang terdeteksi sensitif; isi data sensitif langsung melalui noVNC.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            selector: { type: 'string' },
            text: { type: 'string', description: 'Teks elemen target, bukan nilai yang akan diketik' },
            exact: { type: 'boolean' },
            value: { type: 'string', description: 'Nilai non-sensitif yang akan diisi' },
            append: { type: 'boolean', description: 'Jika true, ketik di posisi saat ini; default false menggunakan fill' },
            delayMs: { type: 'number' },
            tabIndex: { type: 'number' }
          },
          required: ['value']
        }
      },
      {
        name: 'browser_select',
        description: 'Pilih opsi pada elemen select menggunakan ref/selector/text.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            selector: { type: 'string' },
            text: { type: 'string' },
            value: { type: 'string' },
            values: { type: 'array', items: { type: 'string' } },
            tabIndex: { type: 'number' }
          }
        }
      },
      {
        name: 'browser_wait',
        description: 'Tunggu waktu tertentu atau sampai selector/text/URL tertentu muncul.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            text: { type: 'string' },
            exact: { type: 'boolean' },
            urlContains: { type: 'string' },
            state: { type: 'string', enum: ['attached','detached','visible','hidden'] },
            timeoutMs: { type: 'number', description: 'Default 10000 ms, maksimum 60000 ms' },
            tabIndex: { type: 'number' }
          }
        }
      },
      {
        name: 'browser_screenshot',
        description: 'Ambil screenshot PNG dari tab browser aktif dan kembalikan sebagai image content.',
        inputSchema: {
          type: 'object',
          properties: {
            fullPage: { type: 'boolean', description: 'Screenshot seluruh halaman; default false' },
            tabIndex: { type: 'number' }
          }
        }
      },
      {
        name: 'browser_tabs',
        description: 'Kelola tab browser: list, new, select, atau close.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list','new','select','close'], description: 'Default list' },
            index: { type: 'number', description: 'Index untuk select/close' },
            url: { type: 'string', description: 'URL opsional saat action=new' },
            timeoutMs: { type: 'number' }
          }
        }
      },
      {
        name: 'browser_back',
        description: 'Navigasi kembali pada tab browser aktif.',
        inputSchema: { type: 'object', properties: { tabIndex: { type: 'number' }, timeoutMs: { type: 'number' } } }
      },
      {
        name: 'browser_reload',
        description: 'Reload tab browser aktif.',
        inputSchema: { type: 'object', properties: { tabIndex: { type: 'number' }, timeoutMs: { type: 'number' } } }
      }];
export function registerBrowserResources(server, browserViewLink, baseUrl) {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{
      uri: BROWSER_UI_URI,
      name: 'Browser Safara',
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: {
          prefersBorder: false,
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [new URL(baseUrl).origin]
          }
        }
      }
    }]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const requestedUri = request.params.uri;
    if (!BROWSER_UI_URI_RE.test(requestedUri)) throw new Error('Resource tidak ditemukan');
    console.error('[UI] resources/read', requestedUri);
    return { contents: [{
      uri: requestedUri,
      mimeType: 'text/html;profile=mcp-app',
      text: readFileSync(new URL('./browser-ui.html', import.meta.url), 'utf8').replace('__BROWSER_ORIGIN__', JSON.stringify(new URL(baseUrl).origin)),
      _meta: {
        ui: {
          prefersBorder: false,
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [new URL(baseUrl).origin]
          }
        },
        'openai/ui': { availableDisplayModes: ['inline'] },
        'openai/widgetDescription': 'Browser bersama Safara yang dapat dikendalikan langsung dari ChatGPT.',
        'openai/widgetPrefersBorder': false,
        'openai/widgetCSP': {
          connect_domains: [],
          resource_domains: [],
          frame_domains: [new URL(baseUrl).origin]
        }
      }
    }] };
  });


}
export async function handleBrowserTool(name,args,browserViewLink) {
    if (name === 'browser_view') {
      const viewLink = browserViewLink();
      console.error('[UI] browser_view invoked');
      return {
        structuredContent: { ready: true },
        content: [{ type: 'text', text: 'Browser Safara siap ditampilkan pada panel interaktif.' }],
        _meta: {
          browserViewUrl: viewLink,
          ui: { resourceUri: BROWSER_UI_URI },
          'openai/outputTemplate': BROWSER_UI_URI
        }
      };
    }

    if (name === 'browser_get_view_url') {
      try {
        const url = browserViewLink();
        const expiresAt = Number(new URL(url).searchParams.get('expires'));
        return {
          structuredContent: { url, expiresAt },
          content: [{ type: 'text', text: 'URL sesi browser siap untuk panel.' }]
        };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser View URL Error: ' + err.message }], isError: true };
      }
    }

    if (name === 'browser_set_mode') {
      try {
        const result = await browserSetMode(args || {});
        return {
          structuredContent: { mode: result.mode, viewport: result.viewport },
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Set Mode Error: ' + err.message }], isError: true };
      }
    }

    if (name === 'browser_open') {
      try {
        const result = await browserOpen(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Open Error: ' + err.message }] , isError: true };
      }
    }

    if (name === 'browser_snapshot') {
      try {
        const result = await browserSnapshot(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Snapshot Error: ' + err.message }] , isError: true };
      }
    }

    if (name === 'browser_click') {
      try {
        const result = await browserClick(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Click Error: ' + err.message }] , isError: true };
      }
    }

    if (name === 'browser_type') {
      try {
        const result = await browserType(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Type Error: ' + err.message }] , isError: true };
      }
    }

    if (name === 'browser_select') {
      try {
        const result = await browserSelect(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Select Error: ' + err.message }] , isError: true };
      }
    }

    if (name === 'browser_wait') {
      try {
        const result = await browserWait(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Wait Error: ' + err.message }] , isError: true };
      }
    }

    if (name === 'browser_screenshot') {
      try {
        const result = await browserScreenshot(args || {});
        return { content: [
          { type: 'text', text: JSON.stringify(result.info, null, 2) },
          { type: 'image', data: result.image, mimeType: 'image/png' }
        ] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Screenshot Error: ' + err.message }] , isError: true };
      }
    }

    if (name === 'browser_tabs') {
      try {
        const result = await browserTabs(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Tabs Error: ' + err.message }] , isError: true };
      }
    }

    if (name === 'browser_back') {
      try {
        const result = await browserBack(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Back Error: ' + err.message }] , isError: true };
      }
    }

    if (name === 'browser_reload') {
      try {
        const result = await browserReload(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Browser Reload Error: ' + err.message }] , isError: true };
      }
    }


return null;
}
