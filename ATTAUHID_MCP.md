# MCP VPS At-Tauhid 3.10.0

The At-Tauhid browser implementation from ad3f8dc is combined with the development workflow modules from Safara core 4ad7cd3 (3.9.0), inspected on 2026-09-28. Safara itself was not modified. At-Tauhid OAuth, signed browser card, shared browser controls and mobile/desktop modes are retained.

## Features

40 MCP tools, including the app-only browser_get_view_url; 13 added tools:
- ssh_create_upload_slot: one-use binary upload with TTL, size/type checks and exclusive creation by default.
- ssh_read_image: PNG/JPEG/WebP image content, realpath and size validation.
- adb_screenshot_visual: requires an already authorized Android device and loopback ADB tunnel; no device was connected or tested during this release.
- ssh_repo_snapshot, ssh_repo_verify, ssh_repo_worktree, ssh_repo_review, ssh_repo_commit_push.
- ssh_checkpoint: non-secret cross-session handoff.
- ssh_project: explicit project profiles.
- browser_smoke: isolated sandboxed Chromium health and screenshot checks.
- ssh_workspace, ssh_agent_board: isolated Git workspaces and task ownership/dependencies; these tools do not spawn AI models.

## Deployment

Service: mcp-vps2.service.
Live source: /home/attauhid/projects/mcp/mcp-server.
Review worktree: /home/attauhid/projects/mcp/mcp-attauhid-upgrade.
Branch: feat/attauhid-safara-parity.

Browser smoke uses existing playwright-core and a root-owned Chromium copy at:
/opt/mcp-attauhid/chromium-1243/chrome-linux64/chrome.
Override via BROWSER_SMOKE_EXECUTABLE_PATH when upgrading Chromium.
AppArmor profile: /etc/apparmor.d/mcp-attauhid-browser-smoke, attached only to that executable and allowing user namespaces. Sandbox remains enabled. The shared interactive browser service is unchanged.

Global upload root defaults to /home/attauhid/private/mcp-uploads (directory mode 700).
Image roots default to /tmp, that upload directory, and /home/attauhid/browser-agent/screenshots.
Use project profile roots for normal project work. Low-level SSH remains an administrative interface.
MCP origin binds to BIND_HOST or loopback 127.0.0.1; public traffic uses the existing tunnel.

## Verification

- 47 module tests passed.
- parity-smoke.mjs: 13 integration checks passed against a loopback sidecar, including actual MCP/SSH, checkpoint, registry, workspace/board lifecycle, sandboxed screenshot, binary transfer and concurrent upload replay rejection.
- Browser schemas, app resources, shared browser connectivity and authentication were retained.
- No real Android device or remote Git push was exercised.

Run npm test for module tests.
Integration script is specific to this VPS; it uses the existing local SSH identity without printing it, temporary fixtures, and a sidecar at port 3101. Run only in the review worktree without a .env file so production configuration cannot override test isolation.

## Source synchronization

GitHub synchronization was repaired on 2026-09-28 by switching origin from HTTPS (HTTP 403) to the existing authorized SSH identity: git@github.com:YayasanAt-Tauhid/mcp-server-vps.git. The At-Tauhid release is pushed to origin/feat/attauhid-safara-parity. origin/main contains the separate Safara deployment and intentionally differs from the At-Tauhid checkout. Do not force push or pull/merge origin/main into the live At-Tauhid checkout without reviewing the deployment-specific differences. Existing At-Tauhid browser commits and unrelated merchant_orders.tsx are preserved.

## Client refresh and rollback

Existing chats may retain a cached tool schema. Refresh the connector or begin a new chat after refreshing its tools.
A service restart clears in-memory MCP/SSH sessions and unused upload slots; reconnect when needed. Persistent browser profile, project registry and checkpoints survive.

Rollback to the pre-upgrade Git commit ad3f8dc via a reviewed revert/worktree; do not reset over unrelated working changes. Restart mcp-vps2.service after restoring the code. Browser sandbox assets may remain safely installed.

## Browser viewer routing (2026-09-29)

The browser login now redirects to `/embed/view`, and the standalone toolbar uses
`/embed/mode`. Both routes must proxy to the embed-auth service on port 6082.
Sending them to noVNC on port 6080 produces a Python `404 File not found` page.
The tracked `attauhid-browser.nginx.conf` is the complete configuration for this
server; keep these exact-match routes ahead of the generic `/embed/` proxy.

To deploy a reviewed configuration, back up the current file outside
`sites-enabled`, install this file as `/etc/nginx/sites-enabled/attauhid-browser`,
run `sudo nginx -t`, then `sudo systemctl reload nginx`. Restore the backup if
validation fails. Reloading Nginx preserves the browser and MCP sessions.

Verification: unauthenticated `/embed/view` redirects to `/embed/login`,
`/embed/mode` returns 401 JSON, and protected noVNC resources require the existing
session. The noVNC origin returns 200 and reaches the connected framebuffer state.
Both mobile (390x844) and desktop (1366x768) browser modes were exercised.
The public automated HTTP probe returned Cloudflare 1010; it did not validate a
signed-in ChatGPT panel. Reopen browser_view to verify the client display.

This snapshot also preserves the live browser-mode state sharing, standalone
viewer controls, rebuilt MCP UI, and literal-safe bundle replacement from the
previous browser update. As verified from remote heads, the deployment branch
is now `attauhid` (renamed from `feat/attauhid-safara-parity`); Safara is `main`.
Do not merge the Safara `origin/main` into this VPS.

## Android embedded WebSocket repair (2026-09-29)

Observed Android WebView requests loaded /embed/view, noVNC assets, and
/embed/mode successfully, while /embed/websockify repeatedly returned 302
from the cookie-only authentication gate. The outer MCP card also displayed
"Terhubung" as soon as it assigned the iframe URL, before any VNC handshake.

The authenticated POST /embed/connection now issues an origin-bound, single-use
WebSocket ticket with a maximum lifetime of 60 seconds and no lifetime beyond its
browser session. Only the exact /embed/websockify upgrade endpoint accepts it.
The existing cookie-only WebSocket flow remains supported with origin validation.
Anonymous traffic, wrong origins, replayed/expired tickets, and other resource
paths remain protected. Login, CSP, cookie attributes, and browser profile are
unchanged. Tickets are carried in the noVNC URL fragment, omitted from WebSocket
access logs, and stripped before forwarding to websockify.

browser-viewer.html retains the full noVNC controls, requests a fresh ticket for
each connection, and reports actual noVNC connection state to the MCP card.
Embedded mode hides the duplicate standalone toolbar. Two bounded automatic
retries and a manual "Sambung ulang" action handle dropped connections.
MCP resource browser-card-v3.html includes the matching state listener.

Validation:
- 52 unit tests passed (npm test), including five ticket security/lifecycle tests.
- Eight isolated integration checks passed (node browser-viewer.integration.mjs):
  protected routes; authenticated ticket issuance; cookie-free WebSocket reaching
  the actual RFB banner; wrong-origin/replay denial; cookie compatibility; protected
  assets and redacted WS access logs; mobile-sized noVNC connection and reconnect;
  embedded toolbar/state messages and a populated framebuffer.
- The integration script uses temporary Nginx/auth sidecars on 16081/16082 and the
  existing live framebuffer. It reads the configured signing key without printing
  it and leaves the shared browser tabs/profile untouched.
- End-to-end display inside the user's ChatGPT Android app still requires reopening
  browser_view; an origin-only test cannot certify that specific client.

Deployment requires the new viewer and ticket module alongside embed-auth.js,
the updated Nginx config, and rebuilt browser-ui.html. Validate/reload Nginx,
restart attauhid-browser-embed-auth.service, then mcp-vps2.service. Auth/MCP
in-memory sessions restart, so open a new browser panel. Do not restart the shared
attauhid-browser.service for this change.

## Fullscreen panel repair (2026-09-29)

The MCP resource declared only inline mode and the App initialization did not
advertise any availableDisplayModes, although the button requested fullscreen.
Both resource discovery/contents and App capabilities now declare inline and
fullscreen, as documented at https://developers.openai.com/plugins/reference.

The panel uses host-provided container height and a flex layout instead of fixed
header-height subtraction. Fullscreen has an explicit Kecilkan action. Display
mode changes retain the existing browser iframe/session. Initial fullscreen
mounts can request a fresh viewer session without requiring replay of tool output.
Unsupported/rejected fullscreen keeps the inline screen visible and offers Buka
layar terpisah using a fresh signed session and the host open-link capability.

Resource URI: browser-card-v4.html. The fullscreen button now includes the visible
word Fullscreen, which helps distinguish this bundle from a cached icon-only UI.
ChatGPT may retain old resource/tool metadata; the user screenshot and absence of
new resources/read requests showed the older bundle was still being displayed.
A connector metadata refresh may be required to load this release.

Validation: node browser-panel.integration.mjs passed seven checks using the
actual MCP SDK, a local MCP stdio server, and a simulated mobile host: resource
metadata, initialization capabilities, visible fullscreen geometry, resize/inline
return without iframe navigation, failure recovery, direct fullscreen mount, and
an unsupported-mode host. The framebuffer is stubbed in this test so it exercises
panel lifecycle without altering the shared browser. This is not a physical
ChatGPT Android end-to-end test. The earlier WebSocket/auth tests still apply;
those services were not changed or restarted for this fullscreen update.
