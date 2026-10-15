# Shared browser — MCP Safara 3.10.0

Safara gains 13 optional shared-browser tools, bringing this deployment from 27 to 40 tools (including app-only browser_get_view_url). Existing development workflows are unchanged.

## Usage

After refreshing the connector schema, ask for browser_view. Open the card to use the same persistent Chromium profile as the browser tools. Users enter passwords/OTP directly in the viewer. browser_type rejects sensitive fields; snapshots omit input values and screenshots mask recognized sensitive inputs.

The viewer has desktop/mobile and fullscreen buttons. MCP can navigate, inspect, click, fill non-sensitive inputs, select options, wait, capture images, and manage tabs. Mobile mode uses viewport/touch/user-agent emulation.

## Authentication and routing

The existing BASE_URL serves /browser/login and /browser/view. No extra DNS or tunnel is required. The browser card v2 no longer embeds a one-time signed URL in the cacheable MCP UI resource. Instead, each user click invokes the app-only `browser_get_view_url` tool to mint a fresh 10-minute link; when the mobile host blocks a new tab, the widget offers a newly minted fallback link requiring a second tap. Consuming the signed link creates an 8-hour HttpOnly, Secure, SameSite=Lax cookie scoped to /browser. Links are single-use. An already signed-in viewer can reopen its session without consuming another link. The `browser_view` tool retains its existing `_meta` link for compatibility, but the UI card no longer reuses it. Real ChatGPT widget navigation is a deployment smoke gate; passing local bridge unit tests alone is not proof that every host permits opening a new tab.

In browser card v3, the gateway is preview-safe: a signed `GET /browser/login` validates the ticket but does **not** consume it. The human explicitly clicks **Lanjutkan ke browser Safara**, which submits a same-origin `POST /browser/login` to consume the one-use ticket and establish the cookie. Any replay/expired request still fails closed. Only a non-secret reason category is logged (`expired`, `replayed`, `bad_signature`, etc.); never log signed URLs, nonces, cookies or secret material. The widget URI is bumped to `ui://safara/browser-card-v3.html` to avoid reusing the pre-fix card template cache, while the v2 resource read remains accepted for backward compatibility. Actual Android app rendering/click still must be validated after deployment.

The viewer, noVNC assets and WebSocket require that session. WebSocket and mode changes also require the configured BASE_URL origin. A WebSocket is closed when its session expires. MCP/API routes retain existing OAuth/bearer authentication. The browser gateway routes are separate from MCP bearer routes.

Public traffic is HTTPS/WSS through the existing tunnel; raw CDP, VNC and noVNC listeners are loopback-only. Restarting MCP clears browser access sessions but does not erase Chromium profile data.

## Deployment requirements

SHARED_BROWSER_ENABLED=true enables the tools/routes; false/unset leaves them disabled for other VPS installations. SHARED_BROWSER_SIGNING_KEY must be a random secret (at least 16 characters); a sufficiently long APPROVE_PASSWORD is a compatibility fallback. Safara uses a separate generated key so the existing approval password is unchanged. BROWSER_CDP_URL defaults to http://127.0.0.1:9222.

Safara deployment:
- Service: safara-shared-browser.service.
- Script: /home/safara/browser-agent/run-shared-browser.sh.
- Persistent profile: /home/safara/browser-agent/profile (mode 700).
- Chromium: /opt/safara/playwright-browsers/chromium-1243/chrome-linux64/chrome, root-owned.
- AppArmor: /etc/apparmor.d/safara-shared-browser permits user namespaces for this executable; Chromium sandbox remains enabled.
- X display :98; CDP 127.0.0.1:9222; VNC localhost:5908; noVNC 127.0.0.1:6080.
- Packages: xvfb, x11vnc, websockify, novnc, openbox, x11-utils.
- Browser installed using the existing Playwright CLI with PLAYWRIGHT_BROWSERS_PATH=/opt/safara/playwright-browsers and install chromium --no-shell.

run-shared-browser.sh allows SHARED_BROWSER_DISPLAY, SHARED_BROWSER_STATE_DIR and SHARED_BROWSER_EXECUTABLE_PATH overrides. The provided unit is a Safara deployment example; adapt the user and paths on another VPS. Existing headless browser smoke stays on its existing canonical headless-shell installation.

## Upload fixes

Upload tokens are checked again after body parsing so concurrent requests cannot reuse a consumed slot. Destination parent realpaths must remain within the slot's allowed roots; symlink/nonregular destinations are rejected. Default non-overwrite writes use exclusive file creation and mode 600.

## Validation

50 module tests and 14 integration checks passed in an isolated sidecar. Integration includes real noVNC framebuffer rendering, desktop/mobile UI buttons, browser controls and sensitive-input rejection, authentication/origin/link replay checks, concurrent binary-upload replay, no-overwrite, symlink boundary rejection and image reading. Screenshot was visually inspected after framebuffer rendering.

Run npm test for module tests. shared-browser-smoke.mjs is a Safara-specific integration script requiring the running shared-browser service, local authorized test SSH identity, and free loopback ports 3101/3112. Run only from an isolated worktree without .env; it refuses production configuration.

## Rollback

Disable SHARED_BROWSER_ENABLED and restart mcp-safara.service to hide browser tools/routes, then stop safara-shared-browser.service if desired. Persistent profile data can remain. A full source rollback must preserve unrelated changes; pre-upgrade source was 4ad7cd3. Do not disable Chromium sandbox, AppArmor globally, or expose CDP/VNC ports publicly.
