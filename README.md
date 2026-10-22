# Portable MCP Development Server

MCP server untuk development berbasis SSH/Git yang dapat dipasang pada banyak VPS dan dipakai untuk banyak project. Core menyediakan repository snapshot, verification, isolated worktree, structured review, safe commit/push, browser smoke, workspace orchestration, checkpoint, dan multi-session agent board.

## Prinsip

- Git/source aktual, service/database aktual, dan deployment aktual tetap sumber kebenaran.
- Secret tidak disimpan di Git. `.env`, private key, token, password, dan credential lain wajib tetap lokal.
- Project profile bersifat non-secret dan disimpan pada target VPS di `~/.mcp-workflow/projects`.
- Satu MCP dapat mengenal beberapa project pada VPS yang sama; `projectId` harus dikirim eksplisit, tidak ada global "selected project" yang dapat bocor antar sesi.
- Satu repository core yang sama dapat dipasang pada VPS lain dengan konfigurasi lokal berbeda.

## Quick start

1. Clone repository sebagai user service non-root.
2. Jalankan `./scripts/install-vps.sh --check`.
3. Jalankan `./scripts/install-vps.sh --prepare`.
4. Edit `.env` secara lokal dan ganti semua placeholder.
5. Jalankan `./scripts/install-vps.sh --install`.
6. Publikasikan endpoint dengan reverse proxy/Cloudflare Tunnel sesuai lingkungan.
7. Hubungkan ChatGPT ke endpoint MCP dan buat project profile.

Dokumentasi lengkap:
- `SETUP_NEW_VPS.md`
- `SETUP_NEW_PROJECT.md`
- `CHATGPT_SETUP.md`
- `ASSISTANT_TOOLS.md` — memori/skills per proyek dan pekerjaan dengan ID/status persisten (3.11.0).

## Tool project-aware

`ssh_project` menyediakan `list/create/update/show/status/verify/smoke`. `ssh_workspace create` dapat menerima `projectId`; bila dipakai, repo path diambil dari profile dan repo path yang berbeda ditolak.

Project profile hanya menyimpan metadata operasional non-secret: repo, handbook, domain smoke, systemd service, dan roots project. Jangan memasukkan credential ke profile.
