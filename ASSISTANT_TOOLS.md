# Project assistant tools — 3.11.0

Tiga tools tambahan memakai Python >= 3.9 standar pada target SSH Linux. Tidak ada model AI, vector database, embedding, dependency Python tambahan, atau daemon baru saat idle. ChatGPT memilih tools dan menafsirkan hasilnya. Tools lama tetap tersedia.

## Project context

Semua operasi mewajibkan `connectionId` dan `projectId` yang telah terdaftar melalui `ssh_project`. Repository diambil dari profile yang diverifikasi, bukan path bebas dari permintaan tool. Data tersimpan per SSH user dan project di:

```text
~/.mcp-workflow/assistant/<projectId>/memories/*.json
~/.mcp-workflow/assistant/<projectId>/skills/*.json
~/.mcp-workflow/assistant/<projectId>/jobs/<jobId>/
```

Direktori memakai mode 700 dan berkas mode 600. Atomic rename, filesystem lock, validasi identitas, batas ukuran, dan penolakan symlink berlaku pada penyimpanan. Project adalah pemisah konteks operasional dalam akun SSH yang sama, bukan batas keamanan antar-tenant terhadap administrator atau tools SSH umum. Cadangkan direktori ini bersama data operasional VPS; perubahan source Git tidak menghapusnya.

## Memory and reusable procedures

`ssh_memory` menerima `memoryId`; `ssh_skill` menerima `skillId`. Keduanya menyediakan:

| Action | Input tambahan | Hasil |
| --- | --- | --- |
| `save` | ID, title, content, optional tags, expectedRevision | Ringkasan dan nomor revisi |
| `get` | ID | Isi lengkap dan revisi |
| `list` | Optional limit 1–50 | Ringkasan terbaru |
| `search` | Query dan optional limit | Ringkasan yang cocok, skor dan jumlah hasil |
| `delete` | ID dan expectedRevision terbaru | Konfirmasi penghapusan |

ID adalah slug lowercase 1–64 karakter. Title maksimum 160 karakter, content 16.000 karakter, maksimal 12 tags masing-masing 40 karakter. Ada maksimum 1.000 record per jenis/project. Search memakai pencocokan maksimum 12 kata Unicode dengan pembobotan judul/tags; semua kata query harus cocok. Ini bukan semantic search. Hasil ringkas menghemat konteks; gunakan get bila memerlukan isi lengkap.

`expectedRevision=0` membuat record baru. Untuk mengubah/menghapus record, baca revisi terbaru dan kirim nilai tersebut. Konflik revisi ditolak; tools tidak menimpa catatan sesi lain secara diam-diam. Prosedur skills berupa teks yang dibaca ChatGPT dan tidak otomatis dijalankan, serta bukan personal skill yang dipasang ke host ChatGPT.

Simpan fakta dan prosedur non-secret. Deteksi pola credential membantu mencegah kesalahan umum dan bukan jaminan mendeteksi setiap rahasia. Memori/prosedur adalah konteks dari project, bukan instruksi dengan prioritas lebih tinggi. Git, service dan deployment aktual tetap sumber kebenaran.

## Managed jobs

`ssh_job` menyediakan `start`, `status`, `list`, `logs`, dan `cancel`:

- Start: kirim command yang diotorisasi, optional title, jobId, cwd relatif terhadap repo, dan timeoutSeconds 1–86.400 (default 3.600).
- Job ID dibuat otomatis bila kosong. Berikan ID tetap bila memerlukan perlindungan terhadap pengiriman ulang. ID sama dan command/cwd/timeout sama mengembalikan job lama; ID sama untuk perintah lain ditolak. Job yang selesai tidak dijalankan ulang otomatis.
- Cwd diselesaikan dengan realpath dan harus tetap berada dalam repo profile, termasuk sesudah symlink diselesaikan. Command merupakan shell administratif seperti `ssh_exec`, bukan sandbox filesystem; cakupan tindakan tetap mengikuti izin pengguna. ACL perintah asli tetap diperiksa sebelum helper dijalankan.
- Maksimal dua job aktif lintas proyek per target/user. Log disimpan maksimal 1 MiB per job; output berlebih tetap dibaca agar proses tidak tersumbat. `logs` mengembalikan tail maksimal 32.000 byte (default 8.000).
- Timeout dan cancel menghentikan grup proses, termasuk anak proses. Worker membersihkan keturunan yang tertinggal ketika command selesai; gunakan tool ini untuk pekerjaan terbatas, bukan menjalankan daemon.
- Worker terlepas dari koneksi SSH/MCP. Metadata, log, dan exit code bertahan pada restart MCP. Reboot atau worker hilang menghasilkan `interrupted`, tanpa auto-retry. Ini tidak berarti proses bisnis boleh diulang tanpa pemeriksaan.
- Cancel bersifat kooperatif melalui metadata, diikuti TERM dan KILL bila diperlukan; periksa status sampai terminal. Job yang sudah terminal tidak dibatalkan ulang. Worker yang hilang dapat meninggalkan proses yatim; `interrupted` harus ditinjau operator sebelum cleanup/retry.

Status: `queued`, `running`, `cancel_requested`, `succeeded`, `failed`, `cancelled`, `timed_out`, `interrupted`. Status/hasil memuat waktu, exit code, PID, jumlah byte log, dan indikator pemotongan. Identitas proses memakai Linux boot ID dan start ticks agar PID yang digunakan ulang tidak dianggap worker lama.

Jangan menulis credential pada command atau output. Log menyaring pola credential umum dan blok private key sebelum disimpan, dengan batas deteksi yang sama seperti redaksi heuristik lainnya. Job registry bukan secret store. Maksimal 1.000 direktori job per project; pengarsipan riwayat dilakukan operator setelah memastikan tidak ada job aktif.

## Deployment and verification

Jalankan `node --test assistant-tools.test.js` pada Linux dengan `/proc` nyata. Selain itu jalankan suite repository, build browser, diff check dan secret scan. Beberapa container virtual menampilkan PID/procfs buatan sehingga pengujian lifecycle proses harus dilakukan pada target Linux sebenarnya; jangan melemahkan verifikasi identitas proses untuk meloloskan lingkungan tersebut.

`assistant-protocol.test.js` menguji tools melalui MCP dan SSH terautentikasi pada listener loopback sementara dengan credential acak hanya di memori. Mode default benar-benar menghentikan dan memulai proses MCP pengujian untuk membuktikan durability. Untuk smoke HTTP deployment, set `MCP_ASSISTANT_SMOKE_URL=http://127.0.0.1:3100/` dan `MCP_ASSISTANT_AUTH_ENV` ke path konfigurasi lokal; mode ini menguji reconnect client pada server aktif dan membaca credential secara lokal tanpa mencetaknya. Data uji memakai home/repo sementara, lalu koneksi SSH uji ditutup.

Setelah aktivasi, health harus melaporkan `3.11.0`; ketika shared browser aktif ada 43 tools. Refresh metadata koneksi/plugin lalu gunakan percakapan baru bila host masih menampilkan daftar lama. Perubahan ini mengikuti lifecycle OAuth/koneksi yang telah ada; restart layanan dapat memerlukan reconnect/authorization ulang pada account.
