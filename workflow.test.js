import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  assertAbsolutePath,
  assertCheckpointId,
  buildRepoSnapshotCommand,
  buildRepoVerifyCommand,
  buildRepoWorktreeCommand,
  buildRepoReviewCommand,
  buildRepoCommitCommand,
  buildRepoPushCommand,
  assertSafeGitRef,
  normalizeCommitPaths,
  isSensitiveRepoPath,
  containsSecretLike,
  normalizeCheckpoint,
  normalizeVerifyScripts,
  parseTaggedOutput,
  shellQuote
} from './workflow.js';

test('shellQuote escapes single quotes safely', () => {
  assert.equal(shellQuote("/tmp/a'b"), "'/tmp/a'\"'\"'b'");
});

test('absolute path validation rejects relative and NUL paths', () => {
  assert.equal(assertAbsolutePath('/srv/repo'), '/srv/repo');
  assert.throws(() => assertAbsolutePath('srv/repo'));
  assert.throws(() => assertAbsolutePath('/srv/\0repo'));
});

test('checkpoint id rejects path traversal', () => {
  assert.equal(assertCheckpointId('audit-ui_20260910.v1'), 'audit-ui_20260910.v1');
  assert.throws(() => assertCheckpointId('../escape'));
  assert.throws(() => assertCheckpointId('a/b'));
});

test('checkpoint normalization keeps operational metadata and rejects secrets', () => {
  const cp = normalizeCheckpoint('task-1', {
    objective: 'Audit UI Safara',
    phase: 'verify',
    project: 'SafaraOjolNative',
    completed: ['typecheck lulus'],
    next: ['smoke test']
  });
  assert.equal(cp.phase, 'verify');
  assert.deepEqual(cp.next, ['smoke test']);
  assert.throws(() => normalizeCheckpoint('task-2', {
    objective: 'bad',
    notes: 'api_' + 'key=' + 'abcdefghijklmnopqrstuvwxyz123456'
  }), /secret/);
});

test('secret detector catches common credentials without flagging ordinary words', () => {
  assert.equal(containsSecretLike('review token handling and password form'), false);
  assert.equal(containsSecretLike('access_' + 'token=' + 'abcdefghijklmnopqrstuvwxyz'), true);
});

test('verify scripts are explicit allowlisted values', () => {
  assert.deepEqual(normalizeVerifyScripts(['test', 'typecheck', 'test']), ['test', 'typecheck']);
  assert.throws(() => normalizeVerifyScripts(['deploy']), /tidak didukung/);
});

test('snapshot command quotes repo path and optionally fetches', () => {
  const command = buildRepoSnapshotCommand("/srv/repo with ' quote", true);
  assert.match(command, /git fetch --all --prune/);
  assert.match(command, /repo='\/srv\/repo with '\"'\"' quote'/);
});

test('verify command contains fixed safety checks and only allowed scripts', () => {
  const command = buildRepoVerifyCommand('/srv/repo', ['typecheck', 'test']);
  assert.match(command, /git diff --check/);
  assert.match(command, /SECRET_SCAN/);
  assert.match(command, /npm run typecheck/);
  assert.match(command, /npm run test/);
  assert.doesNotMatch(command, /npm run build/);
});

test('tagged output parser produces structured fields', () => {
  const parsed = parseTaggedOutput('__BRANCH__\nmain\n__COMMIT__\nabc123\n__STATUS__\n## main...origin/main');
  assert.deepEqual(parsed, { branch: 'main', commit: 'abc123', status: '## main...origin/main' });
});


function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
}

test('verification command executes clean repo and catches untracked secret-like content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-workflow-test-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'test');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"typecheck":"node -e \\"process.exit(0)\\""}}\n');
    git(dir, 'add', 'package.json');
    git(dir, 'commit', '-qm', 'init');

    let r = spawnSync('bash', ['-c', buildRepoVerifyCommand(dir, ['typecheck'])], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /__VERIFY_DONE__\nPASS/);

    writeFileSync(join(dir, 'leak.txt'), 'pass' + 'word=' + 'abcdefghijklmnopqrstuvwxyz123456\n');
    r = spawnSync('bash', ['-c', buildRepoVerifyCommand(dir, [])], { encoding: 'utf8' });
    assert.equal(r.status, 3, r.stderr || r.stdout);
    assert.match(r.stdout, /secret-like content detected/);
    assert.doesNotMatch(r.stdout, /abcdefghijklmnopqrstuvwxyz123456/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot command executes and parses a real git fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-snapshot-test-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'test');
    writeFileSync(join(dir, 'README.md'), 'fixture\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-qm', 'fixture');
    const r = spawnSync('bash', ['-c', buildRepoSnapshotCommand(dir, false)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const parsed = parseTaggedOutput(r.stdout);
    assert.ok(parsed.branch);
    assert.match(parsed.commit, /^[0-9a-f]{40}$/);
    assert.match(parsed.latest, /fixture/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('snapshot and verify support linked Git worktrees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-worktree-test-'));
  const linked = dir + '-linked';
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'test');
    writeFileSync(join(dir, 'README.md'), 'fixture');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'fixture');
    git(dir, 'worktree', 'add', '-qb', 'linked', linked);
    for (const command of [buildRepoSnapshotCommand(linked), buildRepoVerifyCommand(linked)]) {
      const r = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr || r.stdout);
    }
  } finally {
    rmSync(linked, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Git ref and commit path guardrails reject unsafe or sensitive values', () => {
  assert.equal(assertSafeGitRef('feat/coding-agent'), 'feat/coding-agent');
  assert.throws(() => assertSafeGitRef('../main'), /aman/);
  assert.throws(() => assertSafeGitRef('main~1'), /aman/);
  assert.equal(isSensitiveRepoPath('.env.production'), true);
  assert.equal(isSensitiveRepoPath('src/config.js'), false);
  assert.deepEqual(normalizeCommitPaths(['src/a.js', 'src/a.js', 'README.md']), ['src/a.js', 'README.md']);
  assert.throws(() => normalizeCommitPaths(['../escape']), /path/);
  assert.throws(() => normalizeCommitPaths([':(glob)**']), /path/);
  assert.throws(() => normalizeCommitPaths(['.env']), /sensitif/);
});

test('worktree command creates isolated branch and removes only a clean worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-worktree-lifecycle-'));
  const linked = dir + '-linked';
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'test');
    writeFileSync(join(dir, 'README.md'), 'fixture\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-qm', 'fixture');

    let r = spawnSync('bash', ['-c', buildRepoWorktreeCommand(dir, 'create', {
      worktreePath: linked,
      branch: 'feat/toolkit-fixture',
      baseRef: 'HEAD'
    })], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /__BRANCH__\nfeat\/toolkit-fixture/);

    writeFileSync(join(linked, 'dirty.txt'), 'dirty\n');
    r = spawnSync('bash', ['-c', buildRepoWorktreeCommand(dir, 'remove', { worktreePath: linked })], { encoding: 'utf8' });
    assert.equal(r.status, 5);
    assert.match(r.stderr, /masih memiliki perubahan/);
    rmSync(join(linked, 'dirty.txt'));

    r = spawnSync('bash', ['-c', buildRepoWorktreeCommand(dir, 'remove', { worktreePath: linked })], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /__REMOVED__/);
  } finally {
    rmSync(linked, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review command omits patch when a sensitive path is present without reading its content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-review-sensitive-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'test');
    writeFileSync(join(dir, 'README.md'), 'fixture\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-qm', 'fixture');
    writeFileSync(join(dir, 'README.md'), 'changed\n');
    writeFileSync(join(dir, '.env'), 'fixture-private-value\n');

    const r = spawnSync('bash', ['-c', buildRepoReviewCommand(dir, 'HEAD')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /__SENSITIVE_FILES__\n\.env/);
    assert.match(r.stdout, /__PATCH__\nOMITTED:/);
    assert.doesNotMatch(r.stdout, /fixture-private-value/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit command blocks protected branch by default and commits explicit paths when allowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-commit-guard-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'test');
    writeFileSync(join(dir, 'README.md'), 'fixture\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-qm', 'fixture');
    git(dir, 'branch', '-M', 'main');
    writeFileSync(join(dir, 'README.md'), 'changed\n');

    let r = spawnSync('bash', ['-c', buildRepoCommitCommand(dir, 'test: protected guard', ['README.md'], false)], { encoding: 'utf8' });
    assert.equal(r.status, 10);
    assert.match(r.stderr, /protected branch/);

    r = spawnSync('bash', ['-c', buildRepoCommitCommand(dir, 'test: explicit commit', ['README.md'], true)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /__BRANCH__\nmain/);
    assert.match(r.stdout, /__COMMIT__\n[0-9a-f]{40}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit command uses literal pathspecs and push targets the validated branch ref', () => {
  const commitCommand = buildRepoCommitCommand('/srv/repo', 'test: literal path', ['src/file.js'], true);
  assert.match(commitCommand, /git --literal-pathspecs add/);
  const command = buildRepoPushCommand('/srv/repo', 'feat/coding-agent', 'origin');
  assert.match(command, /git push -- 'origin' HEAD:'refs\/heads\/feat\/coding-agent'/);
});
