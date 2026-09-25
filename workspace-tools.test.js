import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertWorkspaceId,
  assertWorkspaceTaskName,
  normalizeWorkspaceTasks,
  normalizeWorkspaceManifest
} from './workspace-tools.js';

test('workspace identifiers are path-safe', () => {
  assert.equal(assertWorkspaceId('feature-20260925'), 'feature-20260925');
  assert.equal(assertWorkspaceTaskName('frontend'), 'frontend');
  assert.throws(() => assertWorkspaceId('../escape'));
  assert.throws(() => assertWorkspaceTaskName('a/b'));
});

test('workspace tasks normalize base refs and reject duplicates', () => {
  assert.deepEqual(normalizeWorkspaceTasks([
    { name: 'frontend', branch: 'feat/front', baseRef: 'origin/main' },
    { name: 'backend', branch: 'feat/back' }
  ]), [
    { name: 'frontend', branch: 'feat/front', baseRef: 'origin/main' },
    { name: 'backend', branch: 'feat/back', baseRef: 'HEAD' }
  ]);
  assert.throws(() => normalizeWorkspaceTasks([
    { name: 'frontend', branch: 'feat/front' },
    { name: 'frontend', branch: 'feat/other' }
  ]), /duplikat/);
  assert.throws(() => normalizeWorkspaceTasks([
    { name: 'a', branch: 'feat/same' },
    { name: 'b', branch: 'feat/same' }
  ]), /duplikat/);
  assert.throws(() => normalizeWorkspaceTasks(new Array(7).fill(null).map((_, i) => ({ name: 't' + i, branch: 'feat/t' + i }))), /1-6/);
});

test('workspace manifest accepts only canonical task paths', () => {
  const treeRoot = '/home/safara/.mcp-workflow/workspaces/trees/ws1';
  const manifest = normalizeWorkspaceManifest('ws1', {
    workspaceId: 'ws1',
    repoPath: '/srv/repo',
    createdAt: '2026-09-25T00:00:00.000Z',
    baseCommit: 'abc123',
    tasks: [
      { name: 'frontend', branch: 'feat/front', baseRef: 'HEAD', worktreePath: treeRoot + '/frontend' },
      { name: 'backend', branch: 'feat/back', baseRef: 'origin/main', worktreePath: treeRoot + '/backend' }
    ]
  }, treeRoot);
  assert.equal(manifest.tasks[0].worktreePath, treeRoot + '/frontend');
  assert.throws(() => normalizeWorkspaceManifest('ws1', {
    workspaceId: 'ws1',
    repoPath: '/srv/repo',
    tasks: [
      { name: 'frontend', branch: 'feat/front', baseRef: 'HEAD', worktreePath: '/srv/other-worktree' }
    ]
  }, treeRoot), /worktreePath/);
});
