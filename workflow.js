const MAX_CHECKPOINT_BYTES = 32 * 1024;
const ALLOWED_PHASES = new Set(['plan', 'implement', 'review', 'verify', 'blocked', 'done']);
const ALLOWED_VERIFY_SCRIPTS = new Set(['typecheck', 'lint', 'test', 'build']);

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function assertAbsolutePath(value, field = 'path') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
    throw new Error(`${field} harus path absolut yang valid`);
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
  return `set -e\nrepo=${q}\ncd "$repo"\ntest -d .git || { echo '__ERROR__ not-a-git-repo'; exit 2; }\n${fetch ? "git fetch --all --prune\n" : ''}printf '__BRANCH__\\n'; git branch --show-current\nprintf '__COMMIT__\\n'; git rev-parse HEAD\nprintf '__UPSTREAM__\\n'; git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true\nprintf '__AHEAD_BEHIND__\\n'; if git rev-parse --verify '@{upstream}' >/dev/null 2>&1; then git rev-list --left-right --count '@{upstream}...HEAD'; else printf 'NA\\n'; fi\nprintf '__STATUS__\\n'; git status --short --branch\nprintf '__LATEST__\\n'; git log -1 --format='%h %s'\nprintf '__SCRIPTS__\\n'; if [ -f package.json ]; then node -e \"const p=require('./package.json'); console.log(Object.keys(p.scripts||{}).sort().join(','))\" 2>/dev/null || true; fi`;
}

export function buildRepoVerifyCommand(repoPath, runScripts = []) {
  assertAbsolutePath(repoPath, 'repoPath');
  const scripts = normalizeVerifyScripts(runScripts);
  const q = shellQuote(repoPath);
  const secretPattern = '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|(^|[^A-Za-z])(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}|(^|[^A-Za-z])sk-[A-Za-z0-9_-]{20,}|(^|[^A-Za-z])gh[pousr]_[A-Za-z0-9]{20,}|(^|[^A-Za-z])AKIA[0-9A-Z]{16}';
  const secretQ = shellQuote(secretPattern);
  const scriptBlock = scripts.map(script => `\nprintf '__RUN_${script.toUpperCase()}__\\n'\nif [ -f package.json ] && node -e \"const p=require('./package.json');process.exit(p.scripts&&p.scripts['${script}']?0:1)\"; then npm run ${script}; else echo 'SKIP: script ${script} tidak tersedia'; fi`).join('');
  return `set -e\nrepo=${q}\ncd "$repo"\ntest -d .git || { echo '__ERROR__ not-a-git-repo'; exit 2; }\nprintf '__DIFF_CHECK__\\n'; git diff --check; git diff --cached --check\nprintf '__STATUS__\\n'; git status --short --branch\nprintf '__DIFF_STAT__\\n'; git diff --stat; git diff --cached --stat\nprintf '__SECRET_SCAN__\\n'; secret_pattern=${secretQ}\nif { { git diff --no-ext-diff --unified=0; git diff --cached --no-ext-diff --unified=0; } | grep '^+' | grep -Ev '^\\+\\+\\+' | grep -Eqi -- "$secret_pattern"; } || { git ls-files --others --exclude-standard | (while IFS= read -r f; do if [ -f "$f" ] && grep -Eqi -- "$secret_pattern" "$f"; then exit 0; fi; done; exit 1); }; then echo 'FAIL: secret-like content detected in diff or untracked files'; exit 3; else echo 'PASS'; fi${scriptBlock}\nprintf '__VERIFY_DONE__\\nPASS\\n'`;
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
