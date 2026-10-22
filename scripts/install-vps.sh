#!/usr/bin/env bash
set -euo pipefail

MODE="${1:---check}"
case "$MODE" in
  --check|--prepare|--install) ;;
  *)
    echo "Usage: $0 [--check|--prepare|--install]" >&2
    exit 2
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURRENT_USER="$(id -un)"
MCP_USER="${MCP_USER:-$CURRENT_USER}"
INSTANCE_NAME="${INSTANCE_NAME:-mcp-development}"
INSTALL_DIR="${INSTALL_DIR:-$ROOT_DIR}"
BROWSER_ROOT="${BROWSER_ROOT:-/opt/mcp-development/playwright-browsers}"
SERVICE_NAME="${SERVICE_NAME:-$INSTANCE_NAME.service}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/.env}"

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Jalankan installer sebagai user service non-root; script akan memakai sudo hanya untuk perubahan sistem." >&2
  exit 2
fi
if [[ "$MCP_USER" != "$CURRENT_USER" ]]; then
  echo "MCP_USER harus sama dengan user yang menjalankan installer agar ownership dependency konsisten." >&2
  exit 2
fi
if [[ ! "$MCP_USER" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]]; then
  echo "MCP_USER tidak valid" >&2
  exit 2
fi
if [[ ! "$INSTANCE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$ ]]; then
  echo "INSTANCE_NAME tidak valid" >&2
  exit 2
fi
if [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,126}\.service$ ]]; then
  echo "SERVICE_NAME tidak valid" >&2
  exit 2
fi
if [[ "$INSTALL_DIR" != /* || "$BROWSER_ROOT" != /* || "$ENV_FILE" != /* ]]; then
  echo "INSTALL_DIR, BROWSER_ROOT, dan ENV_FILE harus absolute path" >&2
  exit 2
fi
for p in "$INSTALL_DIR" "$BROWSER_ROOT" "$ENV_FILE"; do
  if [[ "$p" =~ [[:space:]\|\&] ]]; then
    echo "Path installer tidak boleh mengandung whitespace, |, atau &: $p" >&2
    exit 2
  fi
done
case "${BROWSER_ROOT%/}" in
  /|/opt|/usr|/var|/home|/root|/tmp)
    echo "BROWSER_ROOT terlalu luas" >&2
    exit 2
    ;;
esac

command -v sudo >/dev/null 2>&1 || { echo "sudo diperlukan untuk setup system dependency/service" >&2; exit 2; }
SUDO=(sudo -n)

for cmd in node npm git systemctl curl find stat sed awk grep python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "binary wajib tidak ditemukan: $cmd" >&2; exit 2; }
done

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( node_major < 20 )); then
  echo "Node.js >= 20 diperlukan" >&2
  exit 2
fi

if [[ "$MODE" == "--check" ]]; then
  if [[ -f "$ENV_FILE" ]]; then
    exec node "$ROOT_DIR/scripts/preflight.mjs" --env-file "$ENV_FILE" --runtime
  fi
  exec node "$ROOT_DIR/scripts/preflight.mjs" --env-file "$ROOT_DIR/.env.example" --allow-placeholders
fi

if [[ ! -f "$ENV_FILE" ]]; then
  install -m 600 "$ROOT_DIR/.env.example" "$ENV_FILE"
  echo "Dibuat $ENV_FILE dari .env.example. Isi credential secara lokal; jangan commit .env."
else
  chmod 600 "$ENV_FILE"
fi

cd "$INSTALL_DIR"
npm ci --ignore-scripts

expected_browser_path() {
  BROWSER_SMOKE_BROWSERS_PATH="$BROWSER_ROOT" node --input-type=module - <<'NODE'
import { chromium } from 'playwright';
console.log(chromium.executablePath());
NODE
}

apparmor_parser_bin() {
  local p
  p="$(command -v apparmor_parser 2>/dev/null || true)"
  if [[ -z "$p" && -x /usr/sbin/apparmor_parser ]]; then p=/usr/sbin/apparmor_parser; fi
  printf '%s' "$p"
}

install_browser() {
  echo "Memasang dependency OS Chromium melalui Playwright..."
  "${SUDO[@]}" env PATH="$PATH" "$INSTALL_DIR/node_modules/.bin/playwright" install-deps chromium

  local tmp tmp_browser relative final_browser parser profile_tmp profile_dst
  tmp="$(mktemp -d)"
  PLAYWRIGHT_BROWSERS_PATH="$tmp" "$INSTALL_DIR/node_modules/.bin/playwright" install --only-shell chromium
  tmp_browser="$(PLAYWRIGHT_BROWSERS_PATH="$tmp" node --input-type=module - <<'NODE'
import { chromium } from 'playwright';
console.log(chromium.executablePath());
NODE
)"
  if [[ "$tmp_browser" != "$tmp/"* || ! -x "$tmp_browser" ]]; then
    rm -rf "$tmp"
    echo "Binary Chromium hasil install tidak valid" >&2
    exit 3
  fi
  relative="${tmp_browser#"$tmp/"}"
  final_browser="$BROWSER_ROOT/$relative"

  "${SUDO[@]}" rm -rf -- "$BROWSER_ROOT"
  "${SUDO[@]}" install -d -o root -g root -m 755 "$BROWSER_ROOT"
  "${SUDO[@]}" cp -a "$tmp"/. "$BROWSER_ROOT"/
  "${SUDO[@]}" chown -R root:root "$BROWSER_ROOT"
  "${SUDO[@]}" chmod -R a-w "$BROWSER_ROOT"
  rm -rf "$tmp"

  if [[ ! -x "$final_browser" || "$(stat -c '%U' "$final_browser")" != "root" ]]; then
    echo "Browser canonical tidak valid/root-owned setelah install" >&2
    exit 3
  fi
  if [[ "$(expected_browser_path)" != "$final_browser" ]]; then
    echo "Revision browser canonical tidak cocok dengan Playwright package" >&2
    exit 3
  fi

  parser="$(apparmor_parser_bin)"
  if [[ -z "$parser" ]]; then
    echo "apparmor_parser tidak tersedia; browser sandbox userns profile belum dapat dipasang" >&2
    exit 3
  fi

  profile_tmp="/tmp/${INSTANCE_NAME}-playwright-headless.apparmor"
  profile_dst="/etc/apparmor.d/${INSTANCE_NAME}-playwright-headless"
  sed \
    -e "s|__INSTANCE_NAME__|$INSTANCE_NAME|g" \
    -e "s|__BROWSER_BINARY__|$final_browser|g" \
    "$ROOT_DIR/deploy/apparmor/mcp-playwright-headless.template" >"$profile_tmp"
  "${SUDO[@]}" "$parser" -Q -K "$profile_tmp"
  "${SUDO[@]}" install -o root -g root -m 644 "$profile_tmp" "$profile_dst"
  "${SUDO[@]}" "$parser" -r "$profile_dst"
  rm -f "$profile_tmp"
}

expected_browser="$(expected_browser_path)"
profile_dst="/etc/apparmor.d/${INSTANCE_NAME}-playwright-headless"
if [[ "$MODE" == "--prepare" || ! -x "$expected_browser" || ! -f "$profile_dst" ]] || ! grep -Fq -- "$expected_browser" "$profile_dst" 2>/dev/null; then
  install_browser
fi

if [[ "$MODE" == "--prepare" ]]; then
  echo "Prepare selesai. Edit $ENV_FILE, set BROWSER_SMOKE_BROWSERS_PATH=$BROWSER_ROOT, lalu jalankan --install."
  exit 0
fi

node "$ROOT_DIR/scripts/preflight.mjs" --env-file "$ENV_FILE" --runtime

configured_browser="$(awk -F= '$1=="BROWSER_SMOKE_BROWSERS_PATH"{print substr($0,index($0,"=")+1)}' "$ENV_FILE" | tail -1)"
if [[ -z "$configured_browser" ]]; then
  echo "BROWSER_SMOKE_BROWSERS_PATH belum ada di .env" >&2
  exit 4
fi
if [[ "$configured_browser" != "$BROWSER_ROOT" ]]; then
  echo "BROWSER_SMOKE_BROWSERS_PATH harus sama dengan BROWSER_ROOT yang dikelola installer" >&2
  exit 4
fi

node_bin="$(command -v node)"
service_tmp="/tmp/${SERVICE_NAME}.tmp"
sed \
  -e "s|__MCP_USER__|$MCP_USER|g" \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__INSTANCE_NAME__|$INSTANCE_NAME|g" \
  -e "s|__NODE_BIN__|$node_bin|g" \
  "$ROOT_DIR/deploy/systemd/mcp-development.service.template" >"$service_tmp"

"${SUDO[@]}" install -o root -g root -m 644 "$service_tmp" "/etc/systemd/system/$SERVICE_NAME"
rm -f "$service_tmp"
"${SUDO[@]}" systemctl daemon-reload
"${SUDO[@]}" systemctl enable --now "$SERVICE_NAME"
"${SUDO[@]}" systemctl restart "$SERVICE_NAME"

port="$(awk -F= '$1=="PORT"{gsub(/[[:space:]]/,"",$2); print $2}' "$ENV_FILE" | tail -1)"
sleep 2
curl -fsS "http://127.0.0.1:${port}/health" >/dev/null

echo "Install selesai: $SERVICE_NAME aktif; health loopback lulus."
