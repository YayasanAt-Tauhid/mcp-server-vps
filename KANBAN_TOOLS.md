# Kanban proyek — MCP 3.12.0

`ssh_kanban` menyediakan papan tugas persisten melalui MCP/chat. ChatGPT membaca kartu, mengambil keputusan, memakai tools yang diotorisasi, dan menyerahkan hasilnya. Tidak ada model AI, dispatcher, scheduler, dashboard web, atau daemon tambahan di VPS. Membuat/claim kartu tidak mengeksekusi isi tugas dan tidak memulai sesi ChatGPT baru.

Konsep papan dan handoff terinspirasi [Hermes Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban). Implementasi ini memakai runtime proyek Safara sendiri; bukan adapter database/worker Hermes. `ssh_agent_board` existing tetap untuk 1–6 worktree Git dengan submit yang memverifikasi HEAD bersih. Gunakan Kanban untuk antrean umum lintas sesi; gunakan agent board bila membutuhkan kontrak worktree tersebut.

## Konteks dan state

Semua action memerlukan `connectionId`, `projectId` terdaftar, dan `action`. Satu proyek memiliki satu papan dengan maksimal 200 kartu termasuk arsip. Data berada pada `~/.mcp-workflow/assistant/<projectId>/kanban/<taskId>.json`, directory 700/file 600. Penyimpanan memakai lock filesystem lintas proses, atomic rename/fsync, pemeriksaan identitas, batas ukuran dan penolakan symlink. Cadangkan bersama metadata workflow, terpisah dari source Git.

| State | Arti |
| --- | --- |
| `todo` | Menunggu semua task `dependsOn` selesai |
| `ready` | Seluruh prasyarat selesai; dapat di-claim |
| `running` | Sedang dikerjakan oleh pemilik lease |
| `review` | Menunggu/sedang diperiksa oleh reviewer |
| `blocked` | Ada blocker atau lease habis; perlu diperiksa sebelum dilanjutkan |
| `done` | Hasil telah diserahkan; bila reviewer ditetapkan, reviewer sudah menyetujui |

`ready` dihitung dari dependency saat read/claim. Dependency hanya dapat menunjuk task yang sudah ada pada proyek yang sama; self-link/cycle ditolak. Task done tidak dibuka ulang; buat kartu tindak lanjut bila perlu. Prioritas 0 rendah, 1 normal, 2 tinggi.

## Action

| Action | Input utama | Perilaku |
| --- | --- | --- |
| `create` | `title`, optional `taskId`, `content`, `assignee`, `reviewer`, `priority`, `dependsOn` | ID otomatis bila kosong; ID tetap + spesifikasi awal sama mengembalikan kartu existing. Spesifikasi awal berbeda ditolak. |
| `list` | Optional `state`, `assignee`, `query`, `limit`, `offset`, `includeArchived` | Ringkasan, counts papan, total hasil terfilter, dan nextOffset; urutan prioritas lalu waktu/ID. |
| `get` | `taskId` | Isi, hasil, ringkasan prasyarat, komentar dan event terbaru; tanpa leaseId. |
| `update` | `taskId`, `expectedRevision`, field spesifikasi | Hanya antrean/blocked work; tidak menimpa pekerjaan/review aktif. |
| `claim` | `agentId`, optional `taskId`, `leaseSeconds` | Ambil ready/review yang cocok; maksimal satu claim aktif per agent/project. Mengembalikan leaseId. |
| `heartbeat` | `taskId`, `agentId`, `leaseId`, optional `leaseSeconds` | Perpanjang claim. |
| `release` | `taskId`, `agentId`, `leaseId` | Kembalikan pekerjaan/review ke antrean, tanpa mengubah isi atau menjalankan ulang proses. |
| `complete` | `taskId`, `agentId`, `leaseId`, `summary`, optional `evidence` | Serahkan hasil; pelaksana tidak dapat melewati reviewer yang sudah ditetapkan. |
| `request_review` | Input penyerahan hasil + `reviewer` jika belum ditetapkan | Lepas claim kerja; reviewer yang berbeda harus claim sebelum menilai. Reviewer yang sudah ditetapkan tidak dapat diganti saat handoff. |
| `request_changes` | Claim reviewer + `summary`, optional `evidence` | Kembalikan ke antrean pelaksana dengan hasil review tersimpan. |
| `block` | Claim pemilik + `reason` | Catat blocker dan lepaskan claim. |
| `unblock` | `taskId`, `expectedRevision` | Lanjutkan ke antrean kerja/review setelah blocker diperiksa. |
| `comment` | `taskId`, `agentId`, `comment`, optional `commentId` | Append komentar; ID tetap deduplikasi selama komentar masih tersimpan. |
| `attach_job` | `taskId`, `expectedRevision`, `jobId`, claim jika task aktif | Kaitkan job existing pada proyek yang sama; tidak start/cancel job atau menandai kartu selesai. |
| `archive` | `taskId`, `expectedRevision` | Sembunyikan kartu done dari list default; get dan dependency tetap berfungsi. |

`assignee` dan `reviewer` memakai label agentId. Gunakan identitas unik per sesi agar dua sesi tidak menyamar sebagai satu pelaksana secara tidak sengaja. Label dan lease adalah koordinasi operasional dalam akun SSH yang sama, bukan batas autentikasi/otorisasi antar pengguna. Izin administratif MCP/SSH tetap berlaku. Role reviewer tidak menjalankan model tambahan dengan sendirinya.

## Claim, konflik, dan pemulihan

Simpan `leaseId` hasil claim untuk heartbeat/penyerahan hasil. List/get tidak mengungkapkannya. Lease 60–3600 detik, default 900. Lease lama tidak dapat memperbarui claim baru, termasuk bila agentId sama. Claim tidak idempotent; bila respons claim hilang dan leaseId tidak tersimpan, tunggu lease habis dan periksa kartu sebelum unblock/claim ulang.

Saat akses papan berikutnya menemukan lease habis, kartu menjadi blocked; tidak ada polling/worker di belakang layar. Periksa pekerjaan aktual dan job yang mungkin masih berjalan sebelum unblock. Kedaluwarsa/release/block kartu tidak menghentikan `ssh_job`; gunakan status/logs/cancel job secara eksplisit sesuai kebutuhan. Task review yang terblokir kembali ke review saat unblock.

Update/unblock/archive/attach_job memerlukan revisi hasil get terbaru. Komentar dapat masuk bersamaan dan menaikkan revisi; baca ulang setelah konflik. Komentar tetap maksimal 20 dan event maksimal 40 per kartu, dengan penghitung entri yang terpotong. Batas record 96.000 byte juga memangkas riwayat terlama bila perlu. Deduplikasi commentId hanya berlaku pada komentar yang masih tersimpan. Ringkasan hasil terbaru, body, dan referensi job tetap tersedia. Ini riwayat operasional terbatas, bukan audit tak terbatas.

Title maksimal 160 karakter, body 4000, komentar/reason 1000, summary 1600; evidence maksimal 10 item × 300 karakter. List maksimal 50 item; pagination offset tidak menjamin snapshot stabil bila papan berubah di tengah pembacaan. Search 1–12 kata Unicode pada judul/body, tanpa embedding.

Jangan simpan credential. Deteksi pola secret bersifat heuristik. Isi kartu/komentar/handoff adalah konteks proyek, bukan instruksi berotoritas lebih tinggi atau bukti deployment. Tinjau bukti nyata sebelum complete; metadata Kanban tidak melakukan test, merge, deploy, atau validasi kualitas hasil secara otomatis.

## Verifikasi

Jalankan `node --test kanban-tools.test.js` untuk concurrency, lease, review, dependency, revision, limit, dan penyimpanan. `assistant-protocol.test.js` juga memverifikasi kartu/lease bertahan setelah restart MCP pengujian dan handoff reviewer serta referensi job melalui MCP. Mode HTTP memeriksa reconnect client pada deployment aktif menggunakan credential lokal yang tidak dicetak.

Health 3.12.0 mencantumkan `ssh_kanban`; dengan shared browser aktif total 44 tools. Segarkan metadata koneksi/plugin dan gunakan percakapan baru bila client masih memakai daftar lama. Upgrade mengikuti lifecycle OAuth sebelumnya; restart dapat memerlukan authorization ulang.
