# Menambah VPS ke MCP SSH (server gabungan)

Satu server MCP melayani semua VPS. VPS baru **tidak** perlu memasang MCP sendiri dan **tidak** perlu connector baru di Claude.ai: cukup didaftarkan sebagai *target*. Panduan memasang MCP penuh per VPS (`SETUP_NEW_VPS.md`) hanya untuk kasus server MCP terpisah.

## Alur 5 langkah

Jalankan di VPS yang menjadi host server MCP (saat ini VPS attauhid):

```bash
# 1. Ambil public key server MCP
sudo mcp-target pubkey
```

Di **VPS baru**, tempel baris itu ke `~/.ssh/authorized_keys` user tujuan, dengan pembatas asal koneksi agar key hanya berlaku dari server MCP:

```
from="IP_SERVER_MCP" ssh-ed25519 AAAA... mcp-vps
```

Kembali ke host server MCP:

```bash
# 2. Daftarkan (ssh-keyscan otomatis; host key dipin, tampil untuk dikonfirmasi)
sudo mcp-target add gudang --host 1.2.3.4 --user ubuntu --description "VPS gudang"
#    opsi: --port 22  --key /path/key  --yes (lewati konfirmasi)  --force (timpa target lama)

# 3. Tes koneksi
sudo mcp-target test gudang
```

Di Claude: `ssh_connect({ target: "gudang" })`. Daftar target yang tersedia juga tampil di deskripsi tool `ssh_connect`; target baru terbaca tanpa restart jika registry dimuat ulang, bila tidak muncul restart `mcp-vps2` sekali.

## Perintah lain

```bash
sudo mcp-target list                 # semua target terdaftar
sudo mcp-target test                 # tes semua target
sudo mcp-target set gudang --blacklist 'rm -rf' --upload-root /srv/uploads --image-root /srv/shots
sudo mcp-target set gudang --clear-acl
sudo mcp-target remove gudang        # hanya mencabut dari registry
```

`remove` tidak menghapus key di VPS tujuan: hapus baris `authorized_keys` di sana agar akses benar-benar tertutup.

## Catatan

- Whitelist/blacklist perintah hanya diatur per target lewat `mcp-target set`, bukan oleh model.
- Host key berubah → koneksi ditolak (perlindungan MITM). Setelah reinstall VPS, jalankan `mcp-target add ... --force`.
- Jika firewall tujuan membatasi koneksi baru (mis. `ufw limit 22/tcp`), SFTP memakai ulang koneksi SSH yang sama sehingga aman; hindari membuka banyak koneksi paralel.
- Registry: `/etc/mcp-vps/targets.d/<nama>.json` (root:mcpvps 0640); key server: `/etc/mcp-vps/keys/id_ed25519`.
- Data kanban/memory/checkpoint disimpan di VPS target (`~/.mcp-workflow`), bukan di server MCP.
