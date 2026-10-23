import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, statSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantTools, normalizeAssistantRequest, buildAssistantCommand, createAssistantHandler } from './assistant-tools.js';

const execAsync = promisify(execFile);
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'mcp-assistant-'));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, HOME: home };
  const command = (tool, args, projectId = 'demo') => buildAssistantCommand(tool, { projectId, ...args }, repo);
  const call = (tool, args, projectId) => JSON.parse(execFileSync('/bin/sh', ['-c', command(tool, args, projectId)], { env, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }));
  const callAsync = async (tool, args, projectId) => JSON.parse((await execAsync('/bin/sh', ['-c', command(tool, args, projectId)], { env, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })).stdout);
  const file = (namespace, id, projectId = 'demo') => join(home, '.mcp-workflow', 'assistant', projectId, namespace, id);
  async function waitJob(id, projectId = 'demo', predicate = job => terminal.has(job.state)) {
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      const response = call('ssh_job', { action: 'status', jobId: id }, projectId);
      assert.equal(response.ok, true, JSON.stringify(response));
      if (predicate(response.job)) return response.job;
      await delay(70);
    }
    throw new Error('Job did not reach expected state: ' + id);
  }
  t.after(async () => {
    const base = join(home, '.mcp-workflow', 'assistant');
    if (existsSync(base)) for (const project of readdirSync(base)) {
      const jobs = join(base, project, 'jobs');
      if (!existsSync(jobs) || !statSync(jobs).isDirectory()) continue;
      for (const id of readdirSync(jobs)) {
        try {
          const value = JSON.parse(readFileSync(join(jobs, id, 'job.json'), 'utf8'));
          if (!terminal.has(value.state)) {
            call('ssh_job', { action: 'cancel', jobId: id }, project);
            await waitJob(id, project);
          }
          if (value.state === 'interrupted' && value.process?.pid) {
            try { process.kill(-value.process.pid, 'SIGKILL'); } catch {}
          }
        } catch {}
      }
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { home, repo, call, callAsync, file, waitJob };
}

test('memory search is project scoped, Unicode aware, bounded, revision protected and private', t => {
  const f = fixture(t);
  const first = f.call('ssh_memory', { action: 'save', memoryId: 'operasi', title: 'Prosedur Safara', content: 'Catatan ＲＵＳＴＢＡＳＥ dan العربية untuk layanan.', tags: ['operasi'] });
  assert.equal(first.ok, true);
  assert.equal(first.entry.revision, 1);
  assert.equal(first.entry.content, undefined);
  const search = f.call('ssh_memory', { action: 'search', query: 'rustbase العربية', limit: 1 });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].memoryId, 'operasi');
  assert.ok(search.items[0].score > 0);
  assert.equal(f.call('ssh_memory', { action: 'search', query: 'rustbase' }, 'other').total, 0);
  assert.equal(f.call('ssh_memory', { action: 'get', memoryId: 'operasi' }, 'other').ok, false);
  assert.match(f.call('ssh_memory', { action: 'save', memoryId: 'operasi', title: 'Oops', content: 'Stale overwrite' }).error, /REVISION_CONFLICT/);
  const updated = f.call('ssh_memory', { action: 'save', memoryId: 'operasi', title: 'Prosedur Safara', content: 'Versi kedua', expectedRevision: 1 });
  assert.equal(updated.entry.revision, 2);
  assert.equal(f.call('ssh_memory', { action: 'get', memoryId: 'operasi' }).entry.content, 'Versi kedua');
  assert.equal(statSync(f.file('memories', 'operasi.json')).mode & 0o777, 0o600);
  assert.equal(statSync(f.file('memories', '')).mode & 0o777, 0o700);
  assert.equal(f.call('ssh_memory', { action: 'delete', memoryId: 'operasi', expectedRevision: 1 }).ok, false);
  assert.equal(f.call('ssh_memory', { action: 'delete', memoryId: 'operasi', expectedRevision: 2 }).deleted, true);
});

test('concurrent memory writers cannot silently overwrite the same revision', async t => {
  const f = fixture(t);
  const args = { action: 'save', memoryId: 'same', title: 'Same', content: 'Initial' };
  assert.equal(f.call('ssh_memory', args).ok, true);
  const responses = await Promise.all([
    f.callAsync('ssh_memory', { ...args, content: 'First update', expectedRevision: 1 }),
    f.callAsync('ssh_memory', { ...args, content: 'Second update', expectedRevision: 1 })
  ]);
  assert.equal(responses.filter(x => x.ok).length, 1);
  assert.equal(responses.filter(x => /REVISION_CONFLICT/.test(x.error)).length, 1);
  assert.equal(f.call('ssh_memory', { action: 'get', memoryId: 'same' }).entry.revision, 2);
});

test('knowledge rejects traversal, secrets, invalid bounds and symlink read/write', t => {
  const f = fixture(t);
  const args = { action: 'save', memoryId: 'safe', title: 'Safe', content: 'Context' };
  for (const patch of [{ memoryId: '../outside' }, { projectId: '../other' }, { title: 'Bad\u0000title' }, { content: 'pass' + 'word=' + 'fakevalue-for-test' }, { tags: Array(13).fill('x') }]) {
    assert.equal(f.call('ssh_memory', { ...args, ...patch }).ok, false);
  }
  assert.equal(f.call('ssh_memory', { action: 'search', query: '* *' }).ok, false);
  assert.equal(f.call('ssh_memory', { action: 'list', limit: 51 }).ok, false);
  const outside = join(f.home, 'outside.json');
  writeFileSync(outside, '{"unchanged":true}');
  symlinkSync(outside, f.file('memories', 'link.json'));
  assert.equal(f.call('ssh_memory', { action: 'get', memoryId: 'link' }).ok, false);
  assert.equal(f.call('ssh_memory', { ...args, memoryId: 'link' }).ok, false);
  assert.equal(readFileSync(outside, 'utf8'), '{"unchanged":true}');
});

test('saved skills are reusable text and shell metacharacters are never executed on save/read', t => {
  const f = fixture(t);
  const marker = join(f.repo, 'must-not-exist');
  const content = '    Inspect source. $(touch ' + marker + ') `touch ' + marker + '`\nThen run checks only when authorized.\n';
  assert.equal(f.call('ssh_skill', { action: 'save', skillId: 'review', title: 'Review', content, tags: ['code'] }).ok, true);
  assert.equal(f.call('ssh_skill', { action: 'get', skillId: 'review' }).entry.content, content);
  assert.equal(f.call('ssh_skill', { action: 'search', query: 'authorized' }).items[0].skillId, 'review');
  assert.equal(existsSync(marker), false);
  assert.equal(f.call('ssh_memory', { action: 'list' }).total, 0);
});

test('jobs persist success, logs and exit code across fresh runtime processes', async t => {
  const f = fixture(t);
  const args = { action: 'start', jobId: 'success', command: "printf 'hello-world\\n'", title: 'Smoke' };
  assert.equal(f.call('ssh_job', args).ok, true);
  const done = await f.waitJob('success');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.exitCode, 0);
  assert.ok(done.startedAt && done.finishedAt);
  const logs = f.call('ssh_job', { action: 'logs', jobId: 'success' });
  assert.match(logs.output, /hello-world/);
  assert.ok(logs.job.logBytes > 0);
  assert.equal(f.call('ssh_job', args).reused, true);
  assert.equal(f.call('ssh_job', { action: 'list' }).jobs[0].jobId, 'success');
  assert.equal(statSync(f.file('jobs', 'success/job.json')).mode & 0o777, 0o600);
  assert.equal(f.call('ssh_job', { action: 'status', jobId: 'success' }, 'other').ok, false);
});

test('failed jobs preserve stderr and nonzero exit code', async t => {
  const f = fixture(t);
  f.call('ssh_job', { action: 'start', jobId: 'failure', command: "printf 'expected-error\\n' >&2; exit 7" });
  const done = await f.waitJob('failure');
  assert.equal(done.state, 'failed');
  assert.equal(done.exitCode, 7);
  assert.match(f.call('ssh_job', { action: 'logs', jobId: 'failure' }).output, /expected-error/);
});

test('concurrent starts with one jobId launch a command only once', async t => {
  const f = fixture(t);
  const args = { action: 'start', jobId: 'once', command: "printf 'one\\n' >> marker; sleep 0.2" };
  const responses = await Promise.all([f.callAsync('ssh_job', args), f.callAsync('ssh_job', args)]);
  assert.ok(responses.every(x => x.ok));
  assert.equal(responses.filter(x => !x.reused).length, 1);
  assert.equal((await f.waitJob('once')).state, 'succeeded');
  assert.equal(readFileSync(join(f.repo, 'marker'), 'utf8'), 'one\n');
  assert.match(f.call('ssh_job', { ...args, command: 'echo different' }).error, /JOB_ID_CONFLICT/);
});

test('timeout stops jobs and records a terminal timed_out result', async t => {
  const f = fixture(t);
  f.call('ssh_job', { action: 'start', jobId: 'timeout', command: 'sleep 30', timeoutSeconds: 1 });
  const done = await f.waitJob('timeout');
  assert.equal(done.state, 'timed_out');
  assert.notEqual(done.exitCode, 0);
});

test('cancellation stops the command process group including descendants', async t => {
  const f = fixture(t);
  f.call('ssh_job', { action: 'start', jobId: 'cancel', command: 'sleep 30 & printf "%s\\n" $!; wait' });
  await f.waitJob('cancel', 'demo', job => job.state === 'running');
  let childPid;
  for (let i = 0; i < 20 && !childPid; i++) {
    childPid = Number(f.call('ssh_job', { action: 'logs', jobId: 'cancel' }).output.trim());
    if (!childPid) await delay(40);
  }
  assert.ok(childPid > 0);
  assert.equal(f.call('ssh_job', { action: 'cancel', jobId: 'cancel' }).cancellationRequested, true);
  assert.equal((await f.waitJob('cancel')).state, 'cancelled');
  if (existsSync('/proc/' + childPid + '/stat')) {
    assert.match(readFileSync('/proc/' + childPid + '/stat', 'utf8'), /\) [ZX] /);
  }
  assert.equal(f.call('ssh_job', { action: 'cancel', jobId: 'cancel' }).cancellationRequested, false);
});

test('lost workers become interrupted and idempotent retries do not rerun commands', async t => {
  const f = fixture(t);
  const args = { action: 'start', jobId: 'lost', command: "printf 'only-once\\n' >> marker; sleep 30" };
  f.call('ssh_job', args);
  await f.waitJob('lost', 'demo', job => job.state === 'running');
  const stored = JSON.parse(readFileSync(f.file('jobs', 'lost/job.json'), 'utf8'));
  process.kill(stored.worker.pid, 'SIGKILL');
  await delay(80);
  assert.equal((await f.waitJob('lost')).state, 'interrupted');
  const retry = f.call('ssh_job', args);
  assert.equal(retry.reused, true);
  assert.equal(retry.job.state, 'interrupted');
  assert.equal(readFileSync(join(f.repo, 'marker'), 'utf8'), 'only-once\n');
  try { process.kill(-stored.process.pid, 'SIGKILL'); } catch {}
});

test('logs are bounded and common credential output is redacted before persistence', async t => {
  const f = fixture(t);
  const command = `python3 -c 'print("PASS" + "WORD=" + "dummyvalue123456"); print("x" * 1100000)'`;
  assert.equal(f.call('ssh_job', { action: 'start', jobId: 'bounded', command }).ok, true);
  const done = await f.waitJob('bounded');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.logTruncated, true);
  const raw = readFileSync(f.file('jobs', 'bounded/output.log'), 'utf8');
  assert.ok(Buffer.byteLength(raw) <= 1024 * 1024);
  assert.ok(!raw.includes('dummyvalue123456'));
  assert.ok(raw.includes('[REDACTED]'));
  const logs = f.call('ssh_job', { action: 'logs', jobId: 'bounded', tailBytes: 1000 });
  assert.ok(Buffer.byteLength(logs.output) <= 1000);
  assert.equal(logs.tailTruncated, true);
});

test('job concurrency is limited across projects on the same SSH target', async t => {
  const f = fixture(t);
  assert.equal(f.call('ssh_job', { action: 'start', jobId: 'one', command: 'sleep 30' }).ok, true);
  assert.equal(f.call('ssh_job', { action: 'start', jobId: 'two', command: 'sleep 30' }, 'other').ok, true);
  assert.match(f.call('ssh_job', { action: 'start', jobId: 'three', command: 'echo third' }, 'third').error, /Maksimum 2/);
});

test('job cwd cannot escape project root through traversal or symlinks', async t => {
  const f = fixture(t);
  symlinkSync(f.home, join(f.repo, 'outside'));
  for (const cwd of ['..', 'outside', f.home]) {
    assert.equal(f.call('ssh_job', { action: 'start', jobId: 'escape', command: 'pwd', cwd }).ok, false);
  }
  mkdirSync(join(f.repo, 'sub'));
  assert.equal(f.call('ssh_job', { action: 'start', jobId: 'inside', command: 'pwd', cwd: 'sub' }).ok, true);
  assert.equal((await f.waitJob('inside')).state, 'succeeded');
  assert.match(f.call('ssh_job', { action: 'logs', jobId: 'inside' }).output, /repo\/sub/);
});

test('assistant dispatch preserves command ACL checks and explicit project identity', async () => {
  let executions = 0;
  let profiles = 0;
  const handle = createAssistantHandler({
    checkCommand: () => { throw new Error('Denied by command ACL'); },
    readProject: async () => { profiles++; return { profile: { projectId: 'demo', repoPath: '/project' } }; },
    exec: async () => { executions++; return '{"ok":true}'; }
  });
  await assert.rejects(handle('ssh_job', { connectionId: 'c', projectId: 'demo', action: 'start', command: 'blocked' }), /ACL/);
  assert.equal(executions, 0);
  assert.equal(profiles, 0);
  await handle('ssh_memory', { connectionId: 'c', projectId: 'demo', action: 'list' });
  assert.equal(executions, 1);
  const mismatch = createAssistantHandler({ checkCommand() {}, exec: async () => '{"ok":true}', readProject: async () => ({ profile: { projectId: 'other', repoPath: '/project' } }) });
  await assert.rejects(mismatch('ssh_skill', { connectionId: 'c', projectId: 'demo', action: 'list' }), /tidak sesuai/);
});

test('tool requests reject unknown fields and generate opaque IDs only for new jobs', () => {
  assert.deepEqual(assistantTools.map(tool => tool.name), ['ssh_memory', 'ssh_skill', 'ssh_job', 'ssh_kanban']);
  const base = { connectionId: 'c', projectId: 'demo', action: 'list' };
  assert.throws(() => normalizeAssistantRequest('ssh_memory', { ...base, repoPath: '/outside' }), /Field/);
  assert.throws(() => normalizeAssistantRequest('ssh_memory', { ...base, constructor: 'not-a-schema-field' }), /Field/);
  assert.throws(() => normalizeAssistantRequest('ssh_memory', { ...base, action: 'execute' }), /action/);
  assert.throws(() => normalizeAssistantRequest('ssh_memory', { ...base, projectId: '../bad' }), /projectId/);
  const args = normalizeAssistantRequest('ssh_job', { ...base, action: 'start', command: 'echo hello' });
  assert.match(args.jobId, /^job-[a-z0-9]+-[a-f0-9]{12}$/);
  assert.equal(normalizeAssistantRequest('ssh_job', { ...base, action: 'start', jobId: 'fixed', command: 'echo hello' }).jobId, 'fixed');
});
