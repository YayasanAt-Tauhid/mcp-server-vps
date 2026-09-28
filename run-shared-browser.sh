#!/usr/bin/env bash
set -euo pipefail
export DISPLAY="${SHARED_BROWSER_DISPLAY:-:98}"
state_dir="${SHARED_BROWSER_STATE_DIR:-/home/safara/browser-agent}"
browser_bin="${SHARED_BROWSER_EXECUTABLE_PATH:-/opt/safara/playwright-browsers/chromium-1243/chrome-linux64/chrome}"
mkdir -p "$state_dir/profile" "$state_dir/screenshots"
chmod 700 "$state_dir" "$state_dir/profile" "$state_dir/screenshots"
cleanup() { jobs -pr | xargs -r kill >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
Xvfb "$DISPLAY" -screen 0 1366x768x24 -nolisten tcp &
for attempt in {1..30}; do if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi; sleep 0.2; done
xdpyinfo -display "$DISPLAY" >/dev/null
openbox-session &
"$browser_bin" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$state_dir/profile" --disable-dev-shm-usage --no-first-run \
  --no-default-browser-check --disable-features=Translate --window-size=1366,768 --restore-last-session about:blank &
x11vnc -display "$DISPLAY" -localhost -rfbport 5908 -forever -shared -nopw -quiet &
websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5908 &
wait -n
