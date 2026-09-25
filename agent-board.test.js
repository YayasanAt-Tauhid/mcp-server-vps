import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAgentBoardId,
  assertAgentId,
  normalizeLeaseSeconds,
  normalizeAgentTaskSpecs,
  createAgentBoardState,
  validateAgentBoardState,
  claimAgentTask,
  heartbeatAgentTask,
  submitAgentTask,
  releaseAgentTask,
  summarizeAgentBoard,
  canRemoveAgentBoard,
  assertAgentBoardWorkspaceMapping
} from './agent-board.js';

const workspace = {
  workspaceId: 'ws1',
  repoPath: '/srv/repo',
  tasks: [
    { name: 'frontend', branch: 'feat/front', baseRef: 'main', worktreePath: '/srv/ws/frontend' },
    { name: 'backend', branch: 'feat/back', baseRef: 'main', worktreePath: '/srv/ws/backend' },
    { name: 'review', branch: 'feat/review', baseRef: 'main', worktreePath: '/srv/ws/review' }
  ]
};

const specs = [
  { name: 'frontend', role: 'frontend', objective: 'Implement UI changes.' },
  { name: 'backend', role: 'backend', objective: 'Implement API changes.' },
  { name: 'review', role: 'reviewer', objective: 'Review both branches.', dependsOn: ['frontend', 'backend'] }
];

test('agent identifiers and lease bounds are strict', () => {
  assert.equal(assertAgentBoardId('board-1'), 'board-1');
  assert.equal(assertAgentId('chat:agent-1'), 'chat:agent-1');
  assert.throws(() => assertAgentBoardId('../escape'));
  assert.throws(() => assertAgentId('bad agent'));
  assert.equal(normalizeLeaseSeconds(), 900);
  assert.equal(normalizeLeaseSeconds(60), 60);
  assert.throws(() => normalizeLeaseSeconds(59), /60-3600/);
  assert.throws(() => normalizeLeaseSeconds(3601), /60-3600/);
});

test('task specs map only to workspace tasks and reject cycles/secrets', () => {
  const out = normalizeAgentTaskSpecs(specs, workspace.tasks);
  assert.equal(out[0].worktreePath, '/srv/ws/frontend');
  assert.equal(out[2].dependsOn[0], 'frontend');

  assert.throws(() => normalizeAgentTaskSpecs([
    { name: 'missing', objective: 'x' }
  ], workspace.tasks), /tidak ada di workspace/);

  assert.throws(() => normalizeAgentTaskSpecs([
    { name: 'frontend', objective: 'x', dependsOn: ['backend'] },
    { name: 'backend', objective: 'y', dependsOn: ['frontend'] }
  ], workspace.tasks), /cycle/);

  assert.throws(() => normalizeAgentTaskSpecs([
    { name: 'frontend', objective: ['pass', 'word=', 'super', 'secret', '123'].join('') }
  ], workspace.tasks), /secret/);
});

test('board claim is exclusive and dependency aware', () => {
  const now = Date.parse('2026-09-25T04:00:00.000Z');
  const board = createAgentBoardState({ boardId: 'b1', workspaceId: 'ws1', workspaceManifest: workspace, tasks: specs, nowMs: now });
  validateAgentBoardState('b1', board);

  const first = claimAgentTask(board, { agentId: 'agent-a', taskName: 'frontend', nowMs: now, leaseSeconds: 120 });
  assert.equal(first.state, 'claimed');
  assert.equal(first.agentId, 'agent-a');

  assert.throws(() => claimAgentTask(board, { agentId: 'agent-b', taskName: 'frontend', nowMs: now }), /tidak tersedia/);
  assert.throws(() => claimAgentTask(board, { agentId: 'agent-a', taskName: 'backend', nowMs: now }), /sudah memiliki task aktif/);
  assert.throws(() => claimAgentTask(board, { agentId: 'agent-c', taskName: 'review', nowMs: now }), /dependency/);

  const auto = claimAgentTask(board, { agentId: 'agent-b', nowMs: now });
  assert.equal(auto.name, 'backend');
});

test('expired lease returns task to pending and allows reclaim', () => {
  const now = Date.parse('2026-09-25T04:00:00.000Z');
  const board = createAgentBoardState({ boardId: 'b2', workspaceId: 'ws1', workspaceManifest: workspace, tasks: specs, nowMs: now });
  claimAgentTask(board, { agentId: 'agent-a', taskName: 'frontend', nowMs: now, leaseSeconds: 60 });

  const later = now + 61_000;
  const status = summarizeAgentBoard(board, later);
  assert.equal(status.tasks.find(t => t.name === 'frontend').state, 'pending');
  const reclaimed = claimAgentTask(board, { agentId: 'agent-b', taskName: 'frontend', nowMs: later });
  assert.equal(reclaimed.agentId, 'agent-b');
});

test('heartbeat extends lease and submit records non-secret evidence', () => {
  const now = Date.parse('2026-09-25T04:00:00.000Z');
  const board = createAgentBoardState({ boardId: 'b3', workspaceId: 'ws1', workspaceManifest: workspace, tasks: specs, nowMs: now });
  claimAgentTask(board, { agentId: 'agent-a', taskName: 'frontend', nowMs: now, leaseSeconds: 60 });

  const hb = heartbeatAgentTask(board, { agentId: 'agent-a', taskName: 'frontend', nowMs: now + 30_000, leaseSeconds: 120 });
  assert.equal(hb.leaseExpiresAt, '2026-09-25T04:02:30.000Z');

  const done = submitAgentTask(board, {
    agentId: 'agent-a',
    taskName: 'frontend',
    summary: 'UI implemented and tests passed.',
    commit: 'abcdef1234567',
    evidence: ['npm test passed', 'browser smoke 200'],
    nowMs: now + 40_000
  });
  assert.equal(done.state, 'done');
  assert.equal(done.commit, 'abcdef1234567');

  assert.throws(() => submitAgentTask(board, {
    agentId: 'agent-a',
    taskName: 'backend',
    summary: ['pass', 'word=', 'super', 'secret', '123'].join(''),
    nowMs: now + 40_000
  }));
});

test('release returns ownership safely', () => {
  const now = Date.parse('2026-09-25T04:00:00.000Z');
  const board = createAgentBoardState({ boardId: 'b4', workspaceId: 'ws1', workspaceManifest: workspace, tasks: specs, nowMs: now });
  claimAgentTask(board, { agentId: 'agent-a', taskName: 'frontend', nowMs: now });
  const released = releaseAgentTask(board, {
    agentId: 'agent-a',
    taskName: 'frontend',
    note: 'Waiting for design clarification.',
    nowMs: now + 1_000
  });
  assert.equal(released.state, 'pending');
  assert.equal(released.agentId, null);
  assert.equal(released.lastNote, 'Waiting for design clarification.');
});

test('board becomes removable only when all tasks are done', () => {
  const now = Date.parse('2026-09-25T04:00:00.000Z');
  const board = createAgentBoardState({ boardId: 'b5', workspaceId: 'ws1', workspaceManifest: workspace, tasks: specs, nowMs: now });
  assert.equal(canRemoveAgentBoard(board, now), false);

  claimAgentTask(board, { agentId: 'a', taskName: 'frontend', nowMs: now });
  submitAgentTask(board, { agentId: 'a', taskName: 'frontend', summary: 'done', nowMs: now + 1000 });
  claimAgentTask(board, { agentId: 'b', taskName: 'backend', nowMs: now + 2000 });
  submitAgentTask(board, { agentId: 'b', taskName: 'backend', summary: 'done', nowMs: now + 3000 });
  claimAgentTask(board, { agentId: 'c', taskName: 'review', nowMs: now + 4000 });
  submitAgentTask(board, { agentId: 'c', taskName: 'review', summary: 'review done', nowMs: now + 5000 });

  assert.equal(canRemoveAgentBoard(board, now + 6000), true);
  const status = summarizeAgentBoard(board, now + 6000);
  assert.deepEqual(status.counts, { pending: 0, claimed: 0, done: 3, ready: 0 });
});

test('board mapping must still match the current workspace manifest', () => {
  const now = Date.parse('2026-09-25T04:00:00.000Z');
  const board = createAgentBoardState({ boardId: 'b6', workspaceId: 'ws1', workspaceManifest: workspace, tasks: specs, nowMs: now });
  assert.equal(assertAgentBoardWorkspaceMapping(board, workspace), true);

  const changed = {
    ...workspace,
    tasks: workspace.tasks.map(task => task.name === 'frontend'
      ? { ...task, worktreePath: '/srv/other/frontend' }
      : task)
  };
  assert.throws(() => assertAgentBoardWorkspaceMapping(board, changed), /berbeda dari workspace aktual/);
});

test('persisted board schema rejects unknown fields and malformed events', () => {
  const now = Date.parse('2026-09-25T04:00:00.000Z');
  const board = createAgentBoardState({ boardId: 'b7', workspaceId: 'ws1', workspaceManifest: workspace, tasks: specs, nowMs: now });
  const withExtra = structuredClone(board);
  withExtra.tasks[0].unexpected = 'x';
  assert.throws(() => validateAgentBoardState('b7', withExtra), /field tidak dikenal/);

  const badEvent = structuredClone(board);
  badEvent.events.push({ at: '2026-09-25T04:00:01.000Z', type: 'unknown-event' });
  assert.throws(() => validateAgentBoardState('b7', badEvent), /event type/);
});
