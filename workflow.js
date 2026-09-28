export const CHAT_WORKFLOW_INSTRUCTIONS = `Untuk development, tentukan project/target yang benar sebelum bertindak. Jika project profile tersedia, gunakan ssh_project status/show untuk menemukan repo, handbook, service, dan smoke target; jangan memakai global selected project karena beberapa sesi dapat berjalan paralel. Baca handbook project bila tersedia, lalu pulihkan checkpoint yang cocok dengan tujuan/project pengguna; jangan menganggap checkpoint latest pasti tugas yang dimaksud. Snapshot repo terkait dengan fetch=true, periksa branch/commit/working tree serta service/deployment yang relevan sebelum mengubah atau menyatakan status. Source/Git/database/service/deployment aktual mengungguli checkpoint dan handbook. Jangan menimpa perubahan yang belum diketahui asalnya. Ikuti plan -> test/implement -> review -> verify sesuai lingkup. Untuk proses panjang gunakan ssh_exec_background lalu ssh_check_background; jangan menjalankan ulang job yang masih aktif. Batasi output dengan pencarian terarah. Jangan mencetak secret atau membaca .env ke output. Simpan checkpoint non-secret sesudah milestone dan sebelum akhir sesi dengan objective, completed, next, repoPath, phase serta bukti verifikasi dan blocker di notes. Error tool berarti langkah gagal, bukan selesai. Sebelum commit/push review diff dan secret serta jalankan verifikasi relevan. Perbarui handbook project untuk pengetahuan operasional reusable. Laporkan yang selesai, yang belum diverifikasi, dan langkah berikutnya. Instruksi ini tunduk pada instruksi pengguna dan batas izin host; tidak mengubah limit atau kemampuan model ChatGPT.`;

const MAX_CHECKPOINT_BYTES = 32 * 1024;
const ALLOWED_PHASES = new Set(['plan', 'implement', 'review', 'verify', 'blocked', 'done']);
const ALLOWED_VERIFY_SCRIPTS = new Set(['typecheck', 'lint', 'test', 'build']);

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function assertAbsolutePath(value, field = 'path') {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\0\r\n]/.test(value)) {
    throw new Error(`${field} harus path absolut yang valid`);
  }
  const parts = value.split('/');
  if (parts.some(part => part === '..' || part === '.')) {
    throw new Error(`${field} tidak boleh mengandung traversal path`);
  }
  return value;
}

export function assertCheckpointId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) {
    throw new Error('checkpointId hanya boleh berisi huruf, angka, titik, underscore, dash; maksimum 80 karakter');
  }
  return value;
}

function assertString(value, field, max = 500, optional = false) {
  if (value == null && optional) return;
  if (typeof value !== 'string' || value.length > max) throw new Error(`${field} harus string maksimum ${max} karakter`);
}

function assertStringArray(value, field, maxItems = 50, maxLen = 300) {
  if (value == null) return;
  if (!Array.isArray(value) || value.length > maxItems || value.some(v => typeof v !== 'string' || v.length > maxLen)) {
    throw new Error(`${field} harus array string maksimum ${maxItems} item, tiap item maksimum ${maxLen} karakter`);
  }
}

export function containsSecretLike(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const patterns = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/
  ];
  return patterns.some(re => re.test(text));
}

export function normalizeCheckpoint(checkpointId, data = {}) {
  assertCheckpointId(checkpointId);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('data checkpoint harus object');

  assertString(data.objective ?? '', 'objective', 500);
  assertString(data.project, 'project', 160, true);
  assertString(data.repoPath, 'repoPath', 500, true);
  assertString(data.branch, 'branch', 200, true);
  assertString(data.commit, 'commit', 80, true);
  assertString(data.notes, 'notes', 1500, true);
  assertStringArray(data.completed, 'completed');
  assertStringArray(data.next, 'next');
  assertStringArray(data.artifacts, 'artifacts', 80, 500);

  const phase = data.phase ?? 'plan';
  if (!ALLOWED_PHASES.has(phase)) throw new Error(`phase tidak valid: ${phase}`);

  const normalized = {
    checkpointId,
    objective: data.objective ?? '',
    phase,
    ...(data.project ? { project: data.project } : {}),
    ...(data.repoPath ? { repoPath: data.repoPath } : {}),
    ...(data.branch ? { branch: data.branch } : {}),
    ...(data.commit ? { commit: data.commit } : {}),
    ...(data.completed ? { completed: data.completed } : {}),
    ...(data.next ? { next: data.next } : {}),
    ...(data.artifacts ? { artifacts: data.artifacts } : {}),
    ...(data.notes ? { notes: data.notes } : {})
  };

  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CHECKPOINT_BYTES) throw new Error('checkpoint terlalu besar (maksimum 32 KiB)');
  if (containsSecretLike(serialized)) throw new Error('checkpoint ditolak karena terdeteksi pola credential/secret; simpan hanya metadata operasional non-secret');
  return normalized;
}

export function normalizeVerifyScripts(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('runScripts harus array');
  const unique = [...new Set(value)];
  for (const script of unique) {
    if (!ALLOWED_VERIFY_SCRIPTS.has(script)) throw new Error(`script verifikasi tidak didukung: ${script}`);
  }
  return unique;
}

export function buildRepoSnapshotCommand(repoPath, fetch = false) {
  assertAbsolutePath(repoPath, 'repoPath');
  const q = shellQuote(repoPath);
  return `set -e\nrepo=${q}\ncd "$repo"\ngit rev-parse --show-toplevel >/dev/null 2>&1 || { echo '__ERROR__ not-a-git-repo'; exit 2; }\n${fetch ? "git fetch --all --prune\n" : ''}printf '__BRANCH__\\n'; git branch --show-current\nprintf '__COMMIT__\\n'; git rev-parse HEAD\nprintf '__UPSTREAM__\\n'; git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true\nprintf '__AHEAD_BEHIND__\\n'; if git rev-parse --verify '@{upstream}' >/dev/null 2>&1; then git rev-list --left-right --count '@{upstream}...HEAD'; else printf 'NA\\n'; fi\nprintf '__STATUS__\\n'; git status --short --branch\nprintf '__LATEST__\\n'; git log -1 --format='%h %s'\nprintf '__SCRIPTS__\\n'; if [ -f package.json ]; then node -e \"const p=require('./package.json'); console.log(Object.keys(p.scripts||{}).sort().join(','))\" 2>/dev/null || true; fi`;
}

export function buildRepoVerifyCommand(repoPath, runScripts = []) {
  assertAbsolutePath(repoPath, 'repoPath');
  const scripts = normalizeVerifyScripts(runScripts);
  const q = shellQuote(repoPath);
  const secretPattern = '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|(^|[^A-Za-z])(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}|(^|[^A-Za-z])sk-[A-Za-z0-9_-]{20,}|(^|[^A-Za-z])gh[pousr]_[A-Za-z0-9]{20,}|(^|[^A-Za-z])AKIA[0-9A-Z]{16}';
  const secretQ = shellQuote(secretPattern);
  const scriptBlock = scripts.map(script => `\nprintf '__RUN_${script.toUpperCase()}__\\n'\nif [ -f package.json ] && node -e \"const p=require('./package.json');process.exit(p.scripts&&p.scripts['${script}']?0:1)\"; then npm run ${script}; else echo 'SKIP: script ${script} tidak tersedia'; fi`).join('');
  return `set -e\nrepo=${q}\ncd "$repo"\ngit rev-parse --show-toplevel >/dev/null 2>&1 || { echo '__ERROR__ not-a-git-repo'; exit 2; }\nprintf '__DIFF_CHECK__\\n'; git diff --check; git diff --cached --check\nprintf '__STATUS__\\n'; git status --short --branch\nprintf '__DIFF_STAT__\\n'; git diff --stat; git diff --cached --stat\nprintf '__SECRET_SCAN__\\n'; secret_pattern=${secretQ}\nif { { git diff --no-ext-diff --unified=0; git diff --cached --no-ext-diff --unified=0; } | grep '^+' | grep -Ev '^\\+\\+\\+' | grep -Eqi -- "$secret_pattern"; } || { git ls-files --others --exclude-standard | (while IFS= read -r f; do if [ -f "$f" ] && grep -Eqi -- "$secret_pattern" "$f"; then exit 0; fi; done; exit 1); }; then echo 'FAIL: secret-like content detected in diff or untracked files'; exit 3; else echo 'PASS'; fi${scriptBlock}\nprintf '__VERIFY_DONE__\\nPASS\\n'`;
}

export function parseTaggedOutput(text) {
  const result = {};
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const match = rawLine.match(/^__([A-Z0-9_]+)__$/);
    if (match) {
      current = match[1].toLowerCase();
      result[current] = '';
      continue;
    }
    if (current) result[current] += (result[current] ? '\n' : '') + rawLine;
  }
  return result;
}

export function truncateText(value, max = 16000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n...[output truncated ${text.length - max} chars]`;
}


const PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'prod']);
const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /(^|\/)credentials(?:\.[^\/]+)?\.json$/i,
  /(^|\/)service[-_]?account(?:\.[^\/]+)?\.json$/i
];

export function assertSafeGitRef(value, field = 'ref') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new Error(`${field} harus string 1-200 karakter`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(value) ||
      value.includes('..') || value.includes('@{') || value.includes('//') ||
      value.endsWith('/') || value.endsWith('.') || value.startsWith('-')) {
    throw new Error(`${field} bukan Git ref yang aman`);
  }
  return value;
}

export function assertRepoRelativePath(value, field = 'path') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500 ||
      value.startsWith('/') || value.startsWith('-') || value.startsWith(':') || /[\r\n]/.test(value) || value.includes('\0')) {
    throw new Error(`${field} harus path relatif repo yang aman`);
  }
  const parts = value.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`${field} tidak boleh mengandung traversal/path segment kosong`);
  }
  return value;
}

export function isSensitiveRepoPath(value) {
  const normalized = String(value).replace(/\\/g, '/');
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(normalized));
}

export function normalizeCommitPaths(paths) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100) {
    throw new Error('paths harus array 1-100 path relatif repo');
  }
  const unique = [...new Set(paths.map((value, index) => assertRepoRelativePath(value, `paths[${index}]`)))];
  const sensitive = unique.filter(isSensitiveRepoPath);
  if (sensitive.length) {
    throw new Error(`path sensitif tidak boleh di-stage lewat tool: ${sensitive.join(', ')}`);
  }
  return unique;
}

export function assertCommitMessage(value) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.length > 200 || /[\r\n]/.test(value)) {
    throw new Error('message commit harus satu baris, 3-200 karakter');
  }
  return value.trim();
}

export function assertSafeRemoteName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new Error('remote Git tidak valid');
  }
  return value;
}

export function buildRepoWorktreeCommand(repoPath, action, options = {}) {
  assertAbsolutePath(repoPath, 'repoPath');
  if (!['list', 'create', 'remove'].includes(action)) throw new Error('action worktree tidak valid');
  const repoQ = shellQuote(repoPath);

  if (action === 'list') {
    return `set -e\ncd ${repoQ}\ngit rev-parse --show-toplevel >/dev/null 2>&1 || { echo '__ERROR__ not-a-git-repo'; exit 2; }\nprintf '__WORKTREES__\\n'; git worktree list --porcelain`;
  }

  assertAbsolutePath(options.worktreePath, 'worktreePath');
  const wtQ = shellQuote(options.worktreePath);

  if (action === 'remove') {
    return `set -e\ncd ${repoQ}\ngit rev-parse --show-toplevel >/dev/null 2>&1 || { echo '__ERROR__ not-a-git-repo'; exit 2; }\nwt=${wtQ}\ngit -C "$wt" rev-parse --show-toplevel >/dev/null 2>&1 || { echo 'worktree tidak ditemukan/invalid' >&2; exit 4; }\nif [ -n "$(git -C "$wt" status --porcelain)" ]; then echo 'worktree masih memiliki perubahan; removal ditolak' >&2; exit 5; fi\ngit worktree remove -- "$wt"\nprintf '__REMOVED__\\n%s\\n' "$wt"\nprintf '__WORKTREES__\\n'; git worktree list --porcelain`;
  }

  const branch = assertSafeGitRef(options.branch, 'branch');
  const baseRef = assertSafeGitRef(options.baseRef || 'HEAD', 'baseRef');
  const branchQ = shellQuote(branch);
  const baseQ = shellQuote(baseRef);
  const fetch = !!options.fetch;
  return `set -e\ncd ${repoQ}\ngit rev-parse --show-toplevel >/dev/null 2>&1 || { echo '__ERROR__ not-a-git-repo'; exit 2; }\n${fetch ? 'git fetch --all --prune\n' : ''}wt=${wtQ}\nbranch=${branchQ}\nbase=${baseQ}\n[ ! -e "$wt" ] || { echo 'worktreePath sudah ada' >&2; exit 6; }\nif git show-ref --verify --quiet "refs/heads/$branch"; then echo 'branch lokal sudah ada; create menolak reuse implisit' >&2; exit 7; fi\ngit rev-parse --verify "$base^{commit}" >/dev/null 2>&1 || { echo 'baseRef tidak ditemukan' >&2; exit 8; }\nmkdir -p -- "$(dirname "$wt")"\ngit worktree add -b "$branch" "$wt" "$base"\nprintf '__WORKTREE__\\n%s\\n' "$wt"\nprintf '__BRANCH__\\n%s\\n' "$branch"\nprintf '__COMMIT__\\n'; git -C "$wt" rev-parse HEAD`;
}

export function buildRepoReviewCommand(repoPath, baseRef = 'HEAD') {
  assertAbsolutePath(repoPath, 'repoPath');
  const ref = assertSafeGitRef(baseRef, 'baseRef');
  const repoQ = shellQuote(repoPath);
  const refQ = shellQuote(ref);
  const sensitivePathRegex = '(^|/)(\\.env($|\\.)|\\.npmrc$|\\.pypirc$|id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?$|credentials([^/]*)?\\.json$|service[-_]?account([^/]*)?\\.json$)|\\.(pem|key|p12|pfx)$';
  return `set -e\ncd ${repoQ}\ngit rev-parse --show-toplevel >/dev/null 2>&1 || { echo '__ERROR__ not-a-git-repo'; exit 2; }\nbase=${refQ}\ngit rev-parse --verify "$base^{commit}" >/dev/null 2>&1 || { echo 'baseRef tidak ditemukan' >&2; exit 8; }\nprintf '__BRANCH__\\n'; git branch --show-current\nprintf '__BASE__\\n%s\\n' "$base"\nprintf '__STATUS__\\n'; git status --short --branch\nprintf '__DIFF_CHECK__\\n'; if git diff --check "$base" >/dev/null 2>&1; then echo PASS; else echo FAIL; fi\nprintf '__DIFF_STAT__\\n'; git diff --stat "$base"\nprintf '__CHANGED_FILES__\\n'; git diff --name-status "$base"\nprintf '__UNTRACKED__\\n'; git ls-files --others --exclude-standard\nchanged="$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u )"\nprintf '__SENSITIVE_FILES__\\n'; printf '%s\\n' "$changed" | grep -Ei '${sensitivePathRegex}' || true\nif printf '%s\\n' "$changed" | grep -Eqi '${sensitivePathRegex}'; then\n  printf '__PATCH__\\nOMITTED: perubahan menyentuh path sensitif; review konten harus dilakukan melalui jalur khusus yang tidak mencetak credential.\\n'\nelse\n  printf '__PATCH__\\n'; git diff --no-ext-diff --unified=3 "$base" | head -c 24000 || true\nfi`;
}

export function buildRepoCommitCommand(repoPath, message, paths, allowProtectedBranch = false) {
  assertAbsolutePath(repoPath, 'repoPath');
  const msg = assertCommitMessage(message);
  const normalizedPaths = normalizeCommitPaths(paths);
  const repoQ = shellQuote(repoPath);
  const msgQ = shellQuote(msg);
  const pathArgs = normalizedPaths.map(shellQuote).join(' ');
  const secretPattern = '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|(^|[^A-Za-z])(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}|(^|[^A-Za-z])sk-[A-Za-z0-9_-]{20,}|(^|[^A-Za-z])gh[pousr]_[A-Za-z0-9]{20,}|(^|[^A-Za-z])AKIA[0-9A-Z]{16}';
  const secretQ = shellQuote(secretPattern);
  const sensitivePathRegex = '(^|/)(\\.env($|\\.)|\\.npmrc$|\\.pypirc$|id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?$|credentials([^/]*)?\\.json$|service[-_]?account([^/]*)?\\.json$)|\\.(pem|key|p12|pfx)$';
  const protectedCase = allowProtectedBranch ? '' : `case "$branch" in ${[...PROTECTED_BRANCHES].join('|')}) echo 'protected branch: commit ditolak tanpa allowProtectedBranch=true' >&2; exit 10;; esac\n`;
  return `set -e\ncd ${repoQ}\ngit rev-parse --show-toplevel >/dev/null 2>&1 || { echo '__ERROR__ not-a-git-repo'; exit 2; }\nbranch="$(git branch --show-current)"\n[ -n "$branch" ] || { echo 'detached HEAD: commit ditolak' >&2; exit 9; }\n${protectedCase}if ! git diff --cached --quiet; then echo 'sudah ada staged changes sebelum tool dijalankan; commit ditolak agar tidak mencampur perubahan' >&2; exit 11; fi\ngit --literal-pathspecs add -- ${pathArgs}\ncleanup_stage() { git --literal-pathspecs restore --staged -- ${pathArgs} >/dev/null 2>&1 || git --literal-pathspecs reset -q HEAD -- ${pathArgs} >/dev/null 2>&1 || true; }\nif git diff --cached --quiet; then cleanup_stage; echo 'tidak ada perubahan pada paths yang dipilih' >&2; exit 12; fi\nif git diff --cached --name-only | grep -Eqi '${sensitivePathRegex}'; then cleanup_stage; echo 'staging menghasilkan path sensitif; commit ditolak' >&2; exit 13; fi\ngit diff --cached --check || { cleanup_stage; echo 'git diff --cached --check gagal' >&2; exit 14; }\nsecret_pattern=${secretQ}\nif git diff --cached --no-ext-diff --unified=0 | grep '^+' | grep -Ev '^\\+\\+\\+' | grep -Eqi -- "$secret_pattern"; then cleanup_stage; echo 'secret-like content terdeteksi pada staged diff; commit ditolak' >&2; exit 15; fi\ngit commit -m ${msgQ}\nprintf '__BRANCH__\\n%s\\n' "$branch"\nprintf '__COMMIT__\\n'; git rev-parse HEAD\nprintf '__STATUS__\\n'; git status --short --branch`;
}

export function buildRepoPushCommand(repoPath, branch, remote = 'origin') {
  assertAbsolutePath(repoPath, 'repoPath');
  const safeBranch = assertSafeGitRef(branch, 'branch');
  const safeRemote = assertSafeRemoteName(remote);
  return `set -e\ncd ${shellQuote(repoPath)}\ngit rev-parse --show-toplevel >/dev/null 2>&1 || { echo '__ERROR__ not-a-git-repo'; exit 2; }\ngit push -- ${shellQuote(safeRemote)} HEAD:${shellQuote(`refs/heads/${safeBranch}`)}\nprintf '__PUSHED__\\n%s/%s\\n' ${shellQuote(safeRemote)} ${shellQuote(safeBranch)}`;
}
