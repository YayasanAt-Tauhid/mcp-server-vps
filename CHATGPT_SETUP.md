# Menggunakan MCP dari Akun ChatGPT Lain

Source MCP dan dokumentasi dapat disimpan di GitHub, tetapi koneksi/otorisasi ChatGPT tidak ikut berpindah otomatis antar akun.

## Pada account ChatGPT baru

1. Pastikan MCP server sudah aktif dan health endpoint menunjukkan versi yang diharapkan.
2. Tambahkan/connect endpoint MCP pada account/workspace ChatGPT tersebut.
3. Lakukan OAuth/authorization ulang untuk account baru.
4. Buat koneksi SSH melalui MCP.
5. Jalankan `ssh_project list` untuk melihat project yang tersedia pada target VPS.
6. Jalankan `ssh_project status` pada project tujuan sebelum development.
7. Baca handbook project dan restore checkpoint yang relevan bila ada.

Jangan menyalin token OAuth, password, private key, atau `.env` dari account lama melalui GitHub.

## Memori, skills, dan job — 3.11.0

Refresh metadata koneksi/plugin setelah upgrade untuk menampilkan `ssh_memory`, `ssh_skill`, dan `ssh_job`, lalu mulai percakapan baru. Gunakan `connectionId` dan `projectId` eksplisit. Server menambah alat, bukan model AI atau jatah penggunaan ChatGPT. Akses pada paket/aplikasi mengikuti ketentuan account; hasil pengujian satu account tidak menjamin ketersediaan untuk semua account.

Pada awal pekerjaan, cari catatan relevan melalui `ssh_memory search` dan prosedur melalui `ssh_skill search/get`, lalu cocokkan dengan Git/service aktual. Pada akhir milestone, simpan fakta operasional yang tahan lama. Update/delete memerlukan `expectedRevision` dari hasil get terbaru. Gunakan `ssh_checkpoint` untuk checkpoint sesi yang sudah ada.

Pekerjaan baru yang panjang dapat memakai `ssh_job start`; simpan ID dan gunakan status/logs. Memakai ID yang sama untuk perintah yang sama tidak menjalankan ulang job. Status `interrupted` harus ditinjau sebelum membuat job baru. Prosedur tersimpan tidak otomatis dieksekusi. Lihat `ASSISTANT_TOOLS.md`.

## Kanban proyek — 3.12.0

`ssh_kanban` menambahkan antrean tugas umum per proyek: todo/ready/running/review/blocked/done, assignment, dependensi, komentar, hasil dan referensi `ssh_job`. Refresh metadata lalu mulai percakapan baru untuk memuat tool tersebut. ChatGPT tetap pengendali; claim kartu tidak memulai model atau worker otomatis.

Pada awal sesi, gunakan list/get untuk melihat tujuan dan handoff yang relevan, lalu claim memakai agentId unik sesi. Simpan leaseId untuk heartbeat dan penyerahan hasil. Bila perlu review, gunakan request_review; reviewer berbeda harus claim lalu complete/request_changes. Lease habis menjadi blocked dan perlu pemeriksaan pekerjaan/job aktual sebelum unblock, tanpa menjalankan ulang otomatis. Update/unblock/archive/attach_job memerlukan revisi terbaru. Detail batas, penyimpanan dan contoh action: `KANBAN_TOOLS.md`.

## Workflow sesi baru

```text
connect MCP
→ connect SSH
→ ssh_project status
→ handbook/Git/deployment verification
→ restore checkpoint relevan
→ workspace/worktree
→ implement/test/review
→ commit/push
→ deploy bila memang bagian dari task
→ browser smoke
→ checkpoint
```

## VPS berbeda

Pasang repository core yang sama pada VPS lain menggunakan `SETUP_NEW_VPS.md`. Setiap VPS memiliki `.env`, hostname MCP, project registry, credential, dan service lokal masing-masing. Source core boleh sama; runtime configuration tidak harus sama.
