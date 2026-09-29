#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:99
export PLAYWRIGHT_BROWSERS_PATH=/home/attauhid/browser-agent/browsers
cd /home/attauhid/browser-agent

cleanup() {
  jobs -pr | xargs -r kill >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

mkdir -p /home/attauhid/browser-agent/profile /home/attauhid/browser-agent/screenshots

Xvfb :99 -screen 0 1366x768x24 -nolisten tcp &
sleep 1
openbox-session >/tmp/attauhid-browser-openbox.log 2>&1 &
sleep 1

BROWSER="$(node -e "const {chromium}=require('playwright'); process.stdout.write(chromium.executablePath())")"
"$BROWSER" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/home/attauhid/browser-agent/profile \
  --disable-dev-shm-usage \
  --no-sandbox \
  --no-first-run \
  --disable-infobars \
  --hide-crash-restore-bubble \
  --restore-last-session \
  --no-default-browser-check \
  --disable-features=Translate \
  --window-size=1366,768 \
  >/tmp/attauhid-browser-chromium.log 2>&1 &
sleep 2

x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -nopw -quiet >/tmp/attauhid-browser-x11vnc.log 2>&1 &
sleep 1

websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/tmp/attauhid-browser-novnc.log 2>&1 &

wait -n
