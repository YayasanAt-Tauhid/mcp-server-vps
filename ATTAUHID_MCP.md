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

## Responsive mobile and Claude embed (2026-09-29)

The live public `/embed/login` response was inspected before this change. It had
neither Content-Security-Policy nor X-Frame-Options. Thus the reported Claude
ERR_BLOCKED_BY_CSP was not evidence of an existing ChatGPT-only ancestor policy.
The MCP resource already declared `_meta.ui.csp.frameDomains`; a host-side
`frame-src` restriction cannot be loosened by this server.

Mobile now synchronizes three sizes: the visible phone panel, Chromium's emulated
viewport, and x11vnc's clipped framebuffer. Chromium enters fullscreen to remove
its desktop chrome, and the launcher disables the testing infobar. Width adapts
between 320 and 640 CSS pixels; height adapts between 320 and 768 (the current Xvfb
screen height). Desktop restores the entire 1366x768 framebuffer and window UI.
ResizeObserver handles panel expansion, collapse and phone size changes. The
shared display settings are atomic JSON, with compatibility for the old mode-only
state file. Simultaneous viewers still share one Chromium and display mode.
`run-attauhid-browser.sh` is the deployment copy of browser-agent/run-stack.sh;
it restores the previous browser session and suppresses the crash-restore bubble.

The outer card has a compact toolbar and always offers Buka tab. It obtains a NEW
signed URL on each external-open click; CSP errors/timeouts also expose a readable
fallback and refresh action. The viewer accepts parent messages from the configured
ChatGPT and Claude origins. Claude resources advertise a stable, server-specific
claudemcpcontent.com domain. The resource is browser-card-v5.html.

Nginx and the auth service now apply a limited frame-ancestors policy to the login,
redirect and viewer responses. The defaults are self, ChatGPT's two frontends and
its web-sandbox origin family, claude.ai, and the exact Claude sandbox hashes for
this server's root, trailing-slash root and /sse URLs. No universal wildcard or
wildcard Claude content domain is allowed. For an additional confirmed origin,
update BROWSER_EMBED_ANCESTORS and the matching header in
attauhid-browser.nginx.conf, validate with nginx -t, reload Nginx and restart auth.
Keep the lists consistent: all ancestors of a nested iframe must be permitted.
Do not add X-Frame-Options SAMEORIGIN/DENY to these cross-origin embed routes.

Signed browser login URLs now expire after two minutes and can create a session
only once. Used nonces are persisted with mode 0600 until expiry so an auth-service
restart does not re-enable a consumed URL. Session cookies retain their existing
eight-hour lifetime and HttpOnly/Secure/SameSite=None/Partitioned attributes.
An already authenticated browser can continue using its session. A new tab or
client partition gets a fresh signed URL, or uses /embed/login with the connector
approval password. Login URL queries and WebSocket tickets are omitted from the
Nginx access log. The browser profile and tool restrictions on sensitive input
remain in place.

Inspect public headers with GET (without consuming a real signed ticket):

```sh
curl -sS --max-time 20 -D - -o /dev/null \
  https://browser-vps.hijrah-attauhid.or.id/embed/login \
  | grep -Ei '^(HTTP/|content-security-policy:|x-frame-options:|referrer-policy:|cache-control:)'
```

For an authenticated redirect chain, use a fresh ticket in DevTools Network with
Preserve log and inspect login -> view -> vnc.html. Do not paste nonce/sig or the
session cookie into diagnostic reports. A frame-ancestors violation is a server
allowlist issue; a frame-src violation is the embedding host's policy. If Claude
still refuses nested iframes, Buka tab (or the plain /embed/login URL) is the supported
fallback, with browser_open/browser_snapshot/browser_screenshot for subsequent
agent work. Disabling CSP is unnecessary.

Validation: 55 unit tests; 7 simulated MCP fullscreen/bridge checks; 12 isolated
Nginx/auth/noVNC checks including restricted ancestors, replay rejection, WebSocket
protection and simulated nested Claude origins; 3 real live mobile checks for
360px rendering, actual noVNC pointer alignment, adaptive height/width, and switching
back to desktop. A final 360x638 framebuffer exactly matched its display area and
visually showed the full-width login form. Actual Claude and the user's physical
ChatGPT Android client were not directly exercised.

The release was built from origin/attauhid in an isolated worktree. Deployment
preserves the newer mobile OAuth approval form in the live index.js; that unrelated
change is deliberately not included in this browser commit. Safara/main is not
modified. Before deployment, affected live files and Nginx/launcher configuration
were saved under /home/attauhid/private/mcp-backups/mobile-claude-20260929-110429.
