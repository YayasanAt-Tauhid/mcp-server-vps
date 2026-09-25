# Menambahkan Project Baru

Project profile membuat satu MCP dapat melayani beberapa repository pada VPS yang sama tanpa memakai global "selected project".

## Struktur yang disarankan

```text
/home/app/projects/
├── project-a/
│   ├── app/
│   └── handbook/
└── project-b/
    ├── app/
    └── handbook/
```

Repository aplikasi dan handbook boleh berada di lokasi lain selama path absolut dan tidak terlalu luas.

## Membuat profile

Gunakan tool `ssh_project` action `create`. Contoh payload konseptual tersedia pada `examples/projects/project.example.json`.

Field utama:
- `projectId`: lowercase slug unik;
- `repoPath`: repository aplikasi;
- `handbookPath`: optional living documentation repository;
- `browserHosts`: host yang boleh dirender untuk project tersebut;
- `smokeUrls`: URL HTTPS yang telah diizinkan oleh `browserHosts`;
- `services`: systemd service project;
- `uploadRoots` / `imageRoots`: roots project non-secret untuk konfigurasi file project-aware.

Profile disimpan pada target VPS di:

```text
~/.mcp-workflow/projects/<projectId>.json
```

Directory dibuat mode 700 dan profile mode 600 dengan atomic write.

## Operasi

Gunakan:
- `ssh_project list`
- `ssh_project show`
- `ssh_project status`
- `ssh_project verify`
- `ssh_project smoke`
- `ssh_project update`

`status` membaca kondisi Git repo/handbook dan status systemd service. `verify` menjalankan verification loop pada repo. `smoke` hanya boleh memakai URL yang terdaftar pada profile.

## Workspace project-aware

Untuk task besar, buat `ssh_workspace` dengan `projectId`:

```text
projectId: project-x
workspaceId: project-x-feature-123
tasks:
  - frontend -> feat/project-x-frontend
  - backend  -> feat/project-x-backend
```

Saat `projectId` diberikan, MCP mengambil `repoPath` dari profile. Jika caller juga mengirim repo path yang berbeda, create ditolak.

Agent board yang dibuat di atas workspace tersebut membawa `projectId` dan memvalidasi mapping workspace saat claim/submit.

## Multi-project pada satu VPS

Gunakan project ID eksplisit per operasi. Jangan membuat satu profile dengan root seperti `/home`, `/root`, `/etc`, atau `/var`. Pisahkan database user, service, domain, dan deployment permission bila project mempunyai boundary keamanan berbeda.
