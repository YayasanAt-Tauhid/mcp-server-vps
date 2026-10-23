import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { buildAssistantCommand, normalizeAssistantRequest, createAssistantHandler } from './assistant-tools.js';

const execAsync = promisify(execFile);
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'mcp-kanban-'));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, HOME: home };
  const command = (args, projectId = 'demo') => buildAssistantCommand('ssh_kanban', { projectId, ...args }, repo);
  const call = (args, projectId) => JSON.parse(execFileSync('/bin/sh', ['-c', command(args, projectId)], { env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));
  const concurrent = async (args, projectId) => JSON.parse((await execAsync('/bin/sh', ['-c', command(args, projectId)], { env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })).stdout);
  const file = (id, projectId = 'demo') => join(home, '.mcp-workflow', 'assistant', projectId, 'kanban', id + '.json');
  const get = id => call({ action: 'get', taskId: id }).task;
  const create = (id, extra = {}) => {
    const response = call({ action: 'create', taskId: id, title: id, ...extra });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.task;
  };
  const claim = (id, agentId) => {
    const response = call({ action: 'claim', taskId: id, agentId });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.task;
  };
  const own = (task, action, extra = {}) => call({ action, taskId: task.taskId, agentId: task.owner, leaseId: task.leaseId, ...extra });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, repo, call, concurrent, file, get, create, claim, own };
}

test('Kanban persists scoped tasks, orders priority, searches Unicode and paginates summaries', t => {
  const f = fixture(t);
  const first = f.create('research', { title: 'Kajian العربية', content: 'Periksa ＲＵＳＴＢＡＳＥ', priority: 2 });
  f.create('dependent', { dependsOn: ['research'] });
  f.create('independent');
  assert.equal(first.state, 'ready');
  assert.equal(f.get('dependent').state, 'todo');
  const page = f.call({ action: 'list', limit: 1 });
  assert.equal(page.items[0].taskId, 'research');
  assert.equal(page.items[0].content, undefined);
  assert.equal(page.total, 3);
  assert.equal(page.nextOffset, 1);
  assert.deepEqual(page.counts, { todo: 1, ready: 2, running: 0, review: 0, blocked: 0, done: 0 });
  assert.equal(f.call({ action: 'list', offset: page.nextOffset, limit: 2 }).nextOffset, null);
  assert.equal(f.call({ action: 'list', query: 'العربية rustbase' }).items[0].taskId, 'research');
  assert.equal(f.call({ action: 'list' }, 'other').total, 0);
  assert.equal(f.call({ action: 'get', taskId: 'research' }, 'other').ok, false);
  assert.equal(statSync(f.file('research')).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.home, '.mcp-workflow', 'assistant', 'demo', 'kanban')).mode & 0o777, 0o700);
});

test('stable task IDs deduplicate concurrent creates and preserve edited tasks', async t => {
  const f = fixture(t);
  const args = { action: 'create', taskId: 'once', title: 'Original' };
  const values = await Promise.all([f.concurrent(args), f.concurrent(args)]);
  assert.ok(values.every(value => value.ok));
  assert.equal(values.filter(value => value.reused).length, 1);
  assert.equal(f.call({ ...args, title: 'Different' }).ok, false);
  const edited = f.call({ action: 'update', taskId: 'once', title: 'Edited', expectedRevision: 1 });
  assert.equal(edited.task.title, 'Edited');
  assert.equal(f.call(args).task.title, 'Edited');
});

test('concurrent claims are exclusive and lease IDs are fenced and hidden from board readers', async t => {
  const f = fixture(t);
  f.create('one');
  const results = await Promise.all(['session-a', 'session-b'].map(agentId => f.concurrent({ action: 'claim', taskId: 'one', agentId })));
  assert.equal(results.filter(value => value.ok).length, 1);
  const claimed = results.find(value => value.ok).task;
  assert.match(claimed.leaseId, /^[a-f0-9]{32}$/);
  assert.equal(f.get('one').leaseId, undefined);
  assert.equal(f.call({ action: 'list' }).items[0].leaseId, undefined);
  assert.equal(f.own(claimed, 'heartbeat', { leaseId: 'wrong' }).ok, false);
  assert.equal(f.own(claimed, 'complete', { agentId: 'impostor', summary: 'Wrong' }).ok, false);
  assert.equal(f.own(claimed, 'heartbeat', { leaseSeconds: 3600 }).task.leaseId, claimed.leaseId);
  assert.equal(f.own(claimed, 'release').task.state, 'ready');
  const next = f.claim('one', claimed.owner);
  assert.notEqual(next.leaseId, claimed.leaseId);
  assert.equal(f.own(claimed, 'complete', { summary: 'Stale' }).ok, false);
  assert.equal(f.own(next, 'complete', { summary: 'Verified result' }).task.state, 'done');
});

test('revision conflicts and dependency cycles cannot overwrite tasks', async t => {
  const f = fixture(t);
  f.create('base');
  f.create('child', { dependsOn: ['base'] });
  const updates = await Promise.all(['First', 'Second'].map(title => f.concurrent({ action: 'update', taskId: 'base', title, expectedRevision: 1 })));
  assert.equal(updates.filter(value => value.ok).length, 1);
  assert.equal(updates.filter(value => /REVISION_CONFLICT/.test(value.error)).length, 1);
  const current = f.get('base');
  assert.match(f.call({ action: 'update', taskId: 'base', dependsOn: ['child'], expectedRevision: current.revision }).error, /cycle/);
  assert.deepEqual(f.get('base').dependsOn, []);
  assert.equal(f.call({ action: 'create', taskId: 'self', title: 'Self', dependsOn: ['self'] }).ok, false);
  assert.equal(f.call({ action: 'create', taskId: 'missing', title: 'Missing', dependsOn: ['outside'] }).ok, false);
  assert.equal(existsSync(f.file('missing')), false);
  assert.equal(f.call({ action: 'claim', taskId: 'child', agentId: 'dev' }).ok, false);
});

test('review contract supports changes and prevents premature dependency completion', t => {
  const f = fixture(t);
  f.create('implementation', { assignee: 'developer', reviewer: 'reviewer' });
  f.create('follow-up', { dependsOn: ['implementation'] });
  assert.equal(f.call({ action: 'claim', taskId: 'implementation', agentId: 'wrong' }).ok, false);
  const work = f.claim('implementation', 'developer');
  assert.equal(f.own(work, 'complete', { summary: 'Cannot bypass review' }).ok, false);
  assert.equal(f.own(work, 'request_review', { reviewer: 'developer', summary: 'Self review' }).ok, false);
  assert.equal(f.own(work, 'request_review', { reviewer: 'replacement', summary: 'Cannot switch designated reviewer' }).ok, false);
  assert.equal(f.own(work, 'request_review', { summary: 'Implementation ready', evidence: ['Tests passed'] }).task.state, 'review');
  assert.equal(f.get('follow-up').state, 'todo');
  assert.equal(f.call({ action: 'claim', taskId: 'implementation', agentId: 'developer' }).ok, false);
  const review = f.claim('implementation', 'reviewer');
  assert.equal(f.own(review, 'request_changes', { summary: 'Fix edge case' }).task.state, 'ready');
  assert.equal(f.get('implementation').result.status, 'changes_requested');
  const second = f.claim('implementation', 'developer');
  assert.equal(f.own(second, 'request_review', { summary: 'Edge case fixed' }).ok, true);
  const approval = f.claim('implementation', 'reviewer');
  const done = f.own(approval, 'complete', { summary: 'Reviewed and approved', evidence: ['Regression passed'] });
  assert.equal(done.task.state, 'done');
  assert.equal(done.task.result.reviewedBy, 'reviewer');
  assert.equal(done.task.result.summary, 'Edge case fixed');
  assert.equal(done.task.result.reviewSummary, 'Reviewed and approved');
  assert.equal(f.get('follow-up').state, 'ready');
});

test('expired leases block work instead of silently re-executing and preserve review intent', t => {
  const f = fixture(t);
  f.create('work', { reviewer: 'reviewer' });
  const work = f.claim('work', 'developer');
  function expire() {
    const record = JSON.parse(readFileSync(f.file('work'), 'utf8'));
    record.leaseUntil = 1;
    writeFileSync(f.file('work'), JSON.stringify(record));
  }
  expire();
  const blocked = f.get('work');
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.reason, /Lease expired/);
  assert.equal(f.own(work, 'complete', { summary: 'Stale result' }).ok, false);
  assert.equal(f.call({ action: 'claim', taskId: 'work', agentId: 'other' }).ok, false);
  assert.equal(f.call({ action: 'unblock', taskId: 'work', expectedRevision: work.revision }).ok, false);
  assert.equal(f.call({ action: 'unblock', taskId: 'work', expectedRevision: blocked.revision }).task.state, 'ready');
  const second = f.claim('work', 'developer');
  f.own(second, 'request_review', { summary: 'Ready for review' });
  f.claim('work', 'reviewer');
  expire();
  const reviewBlocked = f.get('work');
  assert.equal(reviewBlocked.state, 'blocked');
  assert.equal(f.call({ action: 'unblock', taskId: 'work', expectedRevision: reviewBlocked.revision }).task.state, 'review');
  assert.equal(f.claim('work', 'reviewer').state, 'review');
});

test('blocking, assignment filters and automatic ready claims retain task context', t => {
  const f = fixture(t);
  f.create('low', { assignee: 'developer', priority: 0 });
  f.create('high', { assignee: 'developer', priority: 2 });
  const work = f.call({ action: 'claim', agentId: 'developer' }).task;
  assert.equal(work.taskId, 'high');
  assert.equal(f.call({ action: 'claim', taskId: 'low', agentId: 'developer' }).ok, false);
  const blocked = f.own(work, 'block', { reason: 'Waiting for user input' }).task;
  assert.equal(blocked.state, 'blocked');
  assert.equal(f.call({ action: 'list', state: 'blocked', assignee: 'developer' }).total, 1);
  assert.equal(f.call({ action: 'unblock', taskId: 'high', expectedRevision: blocked.revision }).task.state, 'ready');
  assert.equal(f.get('high').events.some(event => event.action === 'block'), true);
});

test('concurrent comments append without loss, deduplicate retained IDs and bound history bytes', async t => {
  const f = fixture(t);
  f.create('comments');
  const responses = await Promise.all(['first', 'second'].map(commentId => f.concurrent({ action: 'comment', taskId: 'comments', agentId: 'author', commentId, comment: commentId })));
  assert.ok(responses.every(response => response.ok));
  assert.equal(f.get('comments').comments.length, 2);
  assert.equal(f.call({ action: 'comment', taskId: 'comments', agentId: 'author', commentId: 'first', comment: 'first' }).reused, true);
  assert.equal(f.call({ action: 'comment', taskId: 'comments', agentId: 'author', commentId: 'first', comment: 'Different' }).ok, false);
  for (let i = 0; i < 23; i++) {
    assert.equal(f.call({ action: 'comment', taskId: 'comments', agentId: 'author', comment: '😀'.repeat(900) }).ok, true);
  }
  const record = f.get('comments');
  assert.equal(record.comments.length, 20);
  assert.equal(record.droppedComments, 5);
  assert.ok(statSync(f.file('comments')).size <= 96000);
});

test('task text is inert, invalid inputs and unsafe persisted records fail without following symlinks', t => {
  const f = fixture(t);
  const marker = join(f.repo, 'not-executed');
  f.create('inert', { content: '$(touch ' + marker + ') `touch ' + marker + '`' });
  f.claim('inert', 'developer');
  assert.equal(existsSync(marker), false);
  for (const args of [
    { action: 'create', taskId: '../outside', title: 'Bad' },
    { action: 'create', title: 'Bad', content: false },
    { action: 'create', title: 'Bad', content: 'pass' + 'word=' + 'dummyvalue-for-test' },
    { action: 'create', title: 'Bad', dependsOn: 'inert' },
    { action: 'list', limit: 51 }, { action: 'list', includeArchived: 1 }, { action: 'list', query: '*' }
  ]) assert.equal(f.call(args).ok, false, JSON.stringify(args));
  const outside = join(f.home, 'outside.json');
  writeFileSync(outside, '{"untouched":true}');
  symlinkSync(outside, f.file('link'));
  assert.equal(f.call({ action: 'list' }).ok, false);
  assert.equal(readFileSync(outside, 'utf8'), '{"untouched":true}');
});

test('linked jobs must exist inside the same project and never change a task status', t => {
  const f = fixture(t);
  f.create('task');
  const jobs = join(f.home, '.mcp-workflow', 'assistant', 'demo', 'jobs');
  mkdirSync(join(jobs, 'finished'), { recursive: true });
  writeFileSync(join(jobs, 'finished', 'job.json'), JSON.stringify({ jobId: 'finished', projectId: 'demo', state: 'succeeded', exitCode: 0 }));
  const attached = f.call({ action: 'attach_job', taskId: 'task', expectedRevision: 1, jobId: 'finished' });
  assert.equal(attached.ok, true);
  assert.deepEqual(attached.task.jobIds, ['finished']);
  assert.equal(attached.task.state, 'ready');
  assert.equal(f.call({ action: 'attach_job', taskId: 'task', expectedRevision: attached.task.revision, jobId: 'missing' }).ok, false);
  assert.equal(existsSync(join(jobs, 'missing')), false);
  symlinkSync(join(jobs, 'finished'), join(jobs, 'linked'));
  assert.equal(f.call({ action: 'attach_job', taskId: 'task', expectedRevision: attached.task.revision, jobId: 'linked' }).ok, false);
});

test('only completed tasks can be archived and archived prerequisites remain satisfied', t => {
  const f = fixture(t);
  f.create('parent');
  f.create('child', { dependsOn: ['parent'] });
  assert.equal(f.call({ action: 'archive', taskId: 'parent', expectedRevision: 1 }).ok, false);
  const work = f.claim('parent', 'developer');
  const completed = f.own(work, 'complete', { summary: 'Checked' }).task;
  assert.equal(f.call({ action: 'archive', taskId: 'parent', expectedRevision: completed.revision }).task.archived, true);
  assert.equal(f.get('child').state, 'ready');
  assert.equal(f.call({ action: 'list' }).total, 1);
  assert.equal(f.call({ action: 'list', includeArchived: true }).total, 2);
  assert.equal(f.call({ action: 'comment', taskId: 'parent', agentId: 'author', comment: 'Too late' }).ok, false);
});

test('task limits and corrupt persisted dependency graphs fail without partial mutation', t => {
  const f = fixture(t);
  f.create('base');
  const original = JSON.parse(readFileSync(f.file('base'), 'utf8'));
  for (let i = 0; i < 199; i++) {
    const taskId = 'task-' + i;
    writeFileSync(f.file(taskId), JSON.stringify({ ...original, taskId }));
  }
  assert.equal(f.call({ action: 'list', limit: 50 }).total, 200);
  assert.match(f.call({ action: 'create', taskId: 'overflow', title: 'Overflow' }).error, /200/);
  assert.equal(existsSync(f.file('overflow')), false);
  writeFileSync(f.file('base'), JSON.stringify({ ...original, dependsOn: ['base'] }));
  assert.match(f.call({ action: 'list' }).error, /cycle/);
});

test('Kanban dispatch validates its schema and requires the registered project before execution', async () => {
  const base = { connectionId: 'c', projectId: 'demo', action: 'list' };
  assert.throws(() => normalizeAssistantRequest('ssh_kanban', { ...base, repoPath: '/other' }), /Field/);
  assert.throws(() => normalizeAssistantRequest('ssh_kanban', { ...base, action: 'spawn_ai' }), /action/);
  let executions = 0;
  const handler = createAssistantHandler({ checkCommand() {}, exec: async () => { executions++; return '{"ok":true}'; }, readProject: async () => ({ profile: { projectId: 'other', repoPath: '/other' } }) });
  await assert.rejects(handler('ssh_kanban', base), /tidak sesuai/);
  assert.equal(executions, 0);
  assert.ok(Buffer.byteLength(buildAssistantCommand('ssh_kanban', { projectId: 'demo', action: 'list' }, '/project')) < 30000, 'shared runtime must fit a small SSH exec request');
});
