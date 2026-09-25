# Migrasi MCP 3.8 ke 3.9

MCP 3.9 memindahkan default yang sebelumnya spesifik deployment ke konfigurasi lokal dan project profile. Upgrade source saja belum cukup: periksa konfigurasi runtime sebelum restart.

## Perubahan penting

- fallback `BASE_URL` sekarang loopback generik;
- fallback browser host hanya `127.0.0.1,localhost`;
- browser canonical default menjadi `/opt/mcp-development/playwright-browsers`;
- generic `UPLOAD_ALLOWED_ROOTS` default kosong;
- generic `IMAGE_READ_ALLOWED_ROOTS` default hanya `/tmp`;
- `ssh_project` menjadi registry project-aware;
- `ssh_workspace` dapat menggunakan `projectId`;
- agent board meneruskan `projectId`.

Existing deployment yang memiliki path/domain lama harus menuliskannya eksplisit di `.env` atau project profile sebelum service restart.

## Prosedur aman

1. `git fetch --all --prune` dan pastikan working tree bersih.
2. Review release diff dan jalankan test/audit.
3. Backup konfigurasi lokal dengan mekanisme server yang aman; jangan commit atau mencetak secret.
4. Tambahkan hanya key konfigurasi non-secret yang diperlukan ke `.env`.
5. Pastikan `BROWSER_SMOKE_BROWSERS_PATH` menunjuk browser canonical yang benar untuk deployment existing.
6. Jalankan `npm run preflight`.
7. Restart service MCP.
8. Verifikasi `/health` lokal dan publik.
9. Jalankan browser smoke yang relevan.
10. Buat project profile setelah repo/service/domain aktual diverifikasi.

## Kompatibilitas workspace lama

Workspace 3.8 tanpa `projectId` tetap valid. Workspace baru sebaiknya memakai `projectId` bila repository telah terdaftar sebagai profile. Jangan mengedit manifest workspace/agent board manual.

## Rollback

Jika runtime 3.9 gagal sebelum ada state project baru yang diperlukan, rollback source ke commit/tag 3.8 yang diketahui baik, restore dependency dari lockfile versi tersebut, dan restart service. Jangan menghapus `~/.mcp-workflow` secara massal. Project profile 3.9 adalah metadata non-secret dan dapat dibiarkan saat investigasi.
