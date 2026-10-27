# Setup MCP pada VPS Baru

> Hanya ingin menambah VPS ke server MCP yang sudah ada? Lihat [ADD_VPS_TARGET.md](ADD_VPS_TARGET.md): cukup `mcp-target add`, tanpa memasang MCP baru.

Panduan ini mengasumsikan Linux dengan systemd dan user service non-root. Installer sengaja tidak mengambil script remote dan tidak menerima credential sebagai argumen command line.

## 1. Prasyarat

Sediakan:
- user Linux non-root untuk MCP;
- Node.js 20 atau lebih baru, npm, Git, systemd, curl, dan sudo;
- SSH access yang akan digunakan ChatGPT/MCP ke target development;
- hostname/reverse proxy atau Cloudflare Tunnel bila endpoint akan diakses dari internet.

Clone repository ke directory milik user service, misalnya:

```bash
git clone git@github.com:YayasanAt-Tauhid/mcp-server-vps.git
cd mcp-server-vps
./scripts/install-vps.sh --check
```

Mode `--check` tidak melakukan perubahan. Bila `.env` belum ada, pemeriksaan memakai `.env.example` dengan placeholder diizinkan.

## 2. Prepare dependency

```bash
./scripts/install-vps.sh --prepare
```

Prepare menjalankan `npm ci --ignore-scripts`, memasang dependency OS Chromium melalui Playwright, memasang hanya Chromium Headless Shell, menyalinnya ke path root-owned, dan memasang profile AppArmor exact-path untuk `userns`. Browser sandbox tidak dimatikan.

Jika `.env` belum ada, installer membuat copy mode 600 dari `.env.example`. Isi file tersebut secara lokal. Jangan commit `.env`.

Minimal periksa:
- `APPROVE_PASSWORD`
- `BASE_URL`
- `PORT`
- `BIND_HOST`
- `BROWSER_SMOKE_BROWSERS_PATH`

`MCP_TOKEN` adalah akses bearer statis opsional. Jika digunakan, ganti placeholder dengan nilai kuat; jika tidak diperlukan, boleh dikosongkan dan gunakan OAuth flow.

## 3. Install service

Setelah konfigurasi lokal siap:

```bash
./scripts/install-vps.sh --install
```

Installer melakukan preflight, memasang unit systemd dari template, start/restart service, lalu memeriksa health loopback.

Default template menggunakan:
- user non-root;
- working directory repository;
- restart otomatis;
- `.env` dibaca oleh aplikasi dari working directory.

## 4. Publikasi endpoint

Installer tidak memasang atau mengubah Cloudflare Tunnel/reverse proxy karena topologi jaringan berbeda pada setiap VPS. Arahkan hostname MCP ke loopback port yang dikonfigurasi. Jika menggunakan tunnel, pertahankan `BIND_HOST=127.0.0.1` bila memungkinkan.

Cek:

```bash
curl -fsS http://127.0.0.1:3100/health
```

Lalu cek hostname publik dari client yang sesuai.

## 5. Upgrade

Gunakan workflow terkontrol:

```bash
git fetch --all --prune
git status --short --branch
git pull --ff-only
npm ci --ignore-scripts
npm test
npm audit --omit=dev --audit-level=high
npm run preflight
sudo systemctl restart <instance>.service
```

Sesudah restart, verifikasi health lokal/publik dan browser smoke yang relevan.

## 6. Secret policy

Jangan commit atau dokumentasikan:
- `.env`;
- password/token/API key;
- SSH/private key;
- database credential;
- Cloudflare credential;
- signed secret.

Project profile juga harus non-secret.
