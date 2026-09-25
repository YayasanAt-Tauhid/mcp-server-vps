import { assertSafeGitRef } from './workflow.js';

export function assertWorkspaceId(value, field = 'workspaceId') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(field + ' hanya boleh huruf, angka, titik, underscore, dash; maksimum 64 karakter');
  }
  return value;
}

export function assertWorkspaceTaskName(value, field = 'task.name') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(value)) {
    throw new Error(field + ' tidak valid; maksimum 40 karakter');
  }
  return value;
}

export function normalizeWorkspaceTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 6) {
    throw new Error('tasks harus array 1-6 item');
  }
  const names = new Set();
  const branches = new Set();
  return tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('task[' + index + '] harus object');
    const name = assertWorkspaceTaskName(task.name, 'tasks[' + index + '].name');
    const branch = assertSafeGitRef(task.branch, 'tasks[' + index + '].branch');
    const baseRef = assertSafeGitRef(task.baseRef || 'HEAD', 'tasks[' + index + '].baseRef');
    if (names.has(name)) throw new Error('task name duplikat: ' + name);
    if (branches.has(branch)) throw new Error('branch duplikat: ' + branch);
    names.add(name);
    branches.add(branch);
    return { name, branch, baseRef };
  });
}

export function normalizeWorkspaceManifest(workspaceId, parsed, treeRoot) {
  const id = assertWorkspaceId(workspaceId);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.workspaceId !== id || !Array.isArray(parsed.tasks)) {
    throw new Error('manifest workspace tidak valid');
  }
  if (typeof parsed.repoPath !== 'string' || !parsed.repoPath.startsWith('/') || parsed.repoPath.includes('\0')) {
    throw new Error('manifest.repoPath tidak valid');
  }
  if (typeof treeRoot !== 'string' || !treeRoot.startsWith('/') || treeRoot.includes('\0')) {
    throw new Error('treeRoot tidak valid');
  }

  const normalizedTasks = normalizeWorkspaceTasks(parsed.tasks);
  const tasks = normalizedTasks.map((task, index) => {
    const expectedPath = `${treeRoot}/${task.name}`;
    if (parsed.tasks[index].worktreePath !== expectedPath) {
      throw new Error('manifest workspace memiliki worktreePath tidak valid');
    }
    return { ...task, worktreePath: expectedPath };
  });

  let projectId = null;
  if (parsed.projectId != null) {
    if (typeof parsed.projectId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(parsed.projectId)) {
      throw new Error('manifest.projectId tidak valid');
    }
    projectId = parsed.projectId;
  }

  return {
    workspaceId: id,
    projectId,
    repoPath: parsed.repoPath,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
    baseCommit: typeof parsed.baseCommit === 'string' ? parsed.baseCommit : null,
    tasks
  };
}
