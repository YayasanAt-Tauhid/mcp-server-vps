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

At-Tauhid git fetch to origin returned HTTP 403 on 2026-09-28. origin/main is stale locally. Do not force push or assume it matches Safara main. Reconcile with the latest upstream in a separate branch after repository access is repaired. Existing At-Tauhid browser commits and unrelated merchant_orders.tsx are preserved.

## Client refresh and rollback

Existing chats may retain a cached tool schema. Refresh the connector or begin a new chat after refreshing its tools.
A service restart clears in-memory MCP/SSH sessions and unused upload slots; reconnect when needed. Persistent browser profile, project registry and checkpoints survive.

Rollback to the pre-upgrade Git commit ad3f8dc via a reviewed revert/worktree; do not reset over unrelated working changes. Restart mcp-vps2.service after restoring the code. Browser sandbox assets may remain safely installed.
