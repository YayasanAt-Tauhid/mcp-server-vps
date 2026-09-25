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
