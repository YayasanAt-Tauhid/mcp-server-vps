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
