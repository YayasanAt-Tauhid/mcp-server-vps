import { assertAbsolutePath, assertSafeGitRef, containsSecretLike } from './workflow.js';
import { assertWorkspaceId, assertWorkspaceTaskName } from './workspace-tools.js';

const MAX_BOARD_TASKS = 6;
const DEFAULT_LEASE_SECONDS = 15 * 60;
const MAX_EVENTS = 100;
const EVENT_TYPES = new Set(['board-created', 'lease-expired', 'claimed', 'heartbeat', 'submitted', 'released']);

function assertOnlyKeys(value, allowed, field) {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new Error(field + ' memiliki field tidak dikenal: ' + key);
  }
}

function assertPlainString(value, field, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(field + ' harus string satu baris ' + min + '-' + max + ' karakter');
  }
  return value;
}

function assertMultilineString(value, field, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) {
    throw new Error(field + ' harus string ' + min + '-' + max + ' karakter');
  }
  if (containsSecretLike(value)) throw new Error(field + ' ditolak karena terdeteksi pola secret/credential');
  return value;
}

export function assertAgentBoardId(value, field = 'boardId') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(field + ' tidak valid; gunakan huruf/angka/titik/underscore/dash, maksimum 64 karakter');
  }
  return value;
}

export function assertAgentId(value, field = 'agentId') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value)) {
    throw new Error(field + ' tidak valid; maksimum 80 karakter');
  }
  return value;
}

export function normalizeLeaseSeconds(value) {
  if (value == null) return DEFAULT_LEASE_SECONDS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 60 || n > 3600) throw new Error('leaseSeconds harus 60-3600');
  return n;
}

export function normalizeAgentTaskSpecs(specs, workspaceTasks) {
  if (!Array.isArray(workspaceTasks) || workspaceTasks.length < 1 || workspaceTasks.length > MAX_BOARD_TASKS) {
    throw new Error('workspaceTasks tidak valid');
  }
  if (!Array.isArray(specs) || specs.length < 1 || specs.length > MAX_BOARD_TASKS) {
    throw new Error('tasks agent board harus array 1-6 item');
  }

  const workspaceByName = new Map(workspaceTasks.map(task => [task.name, task]));
  const seen = new Set();
  const normalized = specs.map((spec, index) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('tasks[' + index + '] harus object');
    const name = assertWorkspaceTaskName(spec.name, 'tasks[' + index + '].name');
    if (!workspaceByName.has(name)) throw new Error('task tidak ada di workspace: ' + name);
    if (seen.has(name)) throw new Error('task agent board duplikat: ' + name);
    seen.add(name);

    const role = spec.role == null ? 'implementer' : assertPlainString(spec.role, 'tasks[' + index + '].role', 1, 80);
    const objective = assertMultilineString(spec.objective, 'tasks[' + index + '].objective', 1, 1600);
    const dependsOn = spec.dependsOn == null ? [] : spec.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.length > MAX_BOARD_TASKS - 1) {
      throw new Error('tasks[' + index + '].dependsOn tidak valid');
    }
    const deps = [...new Set(dependsOn.map((dep, depIndex) => assertWorkspaceTaskName(dep, 'dependsOn[' + depIndex + ']')))];
    if (deps.includes(name)) throw new Error('task tidak boleh bergantung pada dirinya sendiri: ' + name);
    return { name, role, objective, dependsOn: deps };
  });

  const names = new Set(normalized.map(task => task.name));
  for (const task of normalized) {
    for (const dep of task.dependsOn) {
      if (!names.has(dep)) throw new Error('dependency tidak ada di agent board: ' + dep);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const byName = new Map(normalized.map(task => [task.name, task]));
  const visit = name => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error('dependency agent board membentuk cycle');
    visiting.add(name);
    for (const dep of byName.get(name).dependsOn) visit(dep);
    visiting.delete(name);
    visited.add(name);
  };
  for (const task of normalized) visit(task.name);

  return normalized.map(spec => {
    const worktree = workspaceByName.get(spec.name);
    return {
      ...spec,
      branch: worktree.branch,
      baseRef: worktree.baseRef,
      worktreePath: worktree.worktreePath
    };
  });
}

function addEvent(state, event) {
  state.events = [...(state.events || []), event].slice(-MAX_EVENTS);
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

export function createAgentBoardState({ boardId, workspaceId, workspaceManifest, tasks, nowMs = Date.now() }) {
  const id = assertAgentBoardId(boardId);
  const ws = assertWorkspaceId(workspaceId);
  if (!workspaceManifest || workspaceManifest.workspaceId !== ws || !Array.isArray(workspaceManifest.tasks)) {
    throw new Error('workspace manifest tidak cocok');
  }
  const normalized = normalizeAgentTaskSpecs(tasks, workspaceManifest.tasks);
  const createdAt = isoFromMs(nowMs);
  const state = {
    version: 1,
    boardId: id,
    workspaceId: ws,
    projectId: workspaceManifest.projectId || null,
    repoPath: workspaceManifest.repoPath,
    createdAt,
    updatedAt: createdAt,
    tasks: normalized.map(task => ({
      ...task,
      state: 'pending',
      agentId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      completedAt: null,
      commit: null,
      summary: null,
      evidence: [],
      lastNote: null
    })),
    events: []
  };
  addEvent(state, { at: createdAt, type: 'board-created' });
  return state;
}

export function validateAgentBoardState(boardId, state) {
  const id = assertAgentBoardId(boardId);
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || state.boardId !== id) {
    throw new Error('agent board state tidak valid');
  }
  assertOnlyKeys(state, ['version','boardId','workspaceId','projectId','repoPath','createdAt','updatedAt','tasks','events'], 'agent board');
  assertWorkspaceId(state.workspaceId);
  if (state.projectId != null && (typeof state.projectId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(state.projectId))) throw new Error('agent board projectId tidak valid');
  assertAbsolutePath(state.repoPath, 'agent board repoPath');
  if (typeof state.createdAt !== 'string' || !Number.isFinite(Date.parse(state.createdAt)) || typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))) {
    throw new Error('timestamp agent board tidak valid');
  }
  if (!Array.isArray(state.tasks) || state.tasks.length < 1 || state.tasks.length > MAX_BOARD_TASKS) {
    throw new Error('agent board tasks tidak valid');
  }

  const names = new Set();
  for (const task of state.tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('agent board task tidak valid');
    assertOnlyKeys(task, ['name','role','objective','dependsOn','branch','baseRef','worktreePath','state','agentId','claimedAt','leaseExpiresAt','completedAt','commit','summary','evidence','lastNote'], 'agent board task');
    const name = assertWorkspaceTaskName(task.name);
    if (names.has(name)) throw new Error('agent board task duplikat: ' + name);
    names.add(name);
    if (!['pending', 'claimed', 'done'].includes(task.state)) throw new Error('state task agent board tidak valid');
    assertPlainString(task.role, 'task.role', 1, 80);
    assertMultilineString(task.objective, 'task.objective', 1, 1600);
    if (!Array.isArray(task.dependsOn)) throw new Error('task.dependsOn tidak valid');
    assertSafeGitRef(task.branch, 'task.branch');
    assertSafeGitRef(task.baseRef, 'task.baseRef');
    assertAbsolutePath(task.worktreePath, 'task.worktreePath');
    if (task.agentId != null) assertAgentId(task.agentId);
    if (task.state === 'claimed') {
      if (!task.agentId || typeof task.claimedAt !== 'string' || typeof task.leaseExpiresAt !== 'string') {
        throw new Error('claimed task tidak memiliki lease/owner valid');
      }
      if (!Number.isFinite(Date.parse(task.claimedAt)) || !Number.isFinite(Date.parse(task.leaseExpiresAt))) {
        throw new Error('timestamp claim tidak valid');
      }
    }
    if (task.state === 'done') {
      if (!task.agentId || typeof task.completedAt !== 'string' || !Number.isFinite(Date.parse(task.completedAt))) {
        throw new Error('done task tidak memiliki metadata completion valid');
      }
      if (task.commit != null && (typeof task.commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(task.commit))) {
        throw new Error('commit persisted tidak valid');
      }
      if (task.summary != null) assertMultilineString(task.summary, 'task.summary', 1, 2400);
      normalizeEvidence(task.evidence);
    }
    if (task.lastNote != null) assertMultilineString(task.lastNote, 'task.lastNote', 1, 1000);
  }
  for (const task of state.tasks) {
    for (const dep of task.dependsOn) if (!names.has(dep)) throw new Error('dependency state tidak valid: ' + dep);
  }
  if (!Array.isArray(state.events) || state.events.length > MAX_EVENTS) throw new Error('agent board events tidak valid');
  for (const event of state.events) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) {
      throw new Error('agent board event tidak valid');
    }
    assertOnlyKeys(event, ['at','type','taskName','agentId','note','commit'], 'agent board event');
    if (!EVENT_TYPES.has(event.type)) throw new Error('agent board event type tidak valid');
    if (event.agentId != null) assertAgentId(event.agentId);
    if (event.taskName != null) assertWorkspaceTaskName(event.taskName, 'event.taskName');
    if (event.note != null) assertMultilineString(event.note, 'event.note', 1, 1000);
    if (event.commit != null && (typeof event.commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(event.commit))) {
      throw new Error('event commit tidak valid');
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const byName = new Map(state.tasks.map(task => [task.name, task]));
  const visit = name => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error('dependency state membentuk cycle');
    visiting.add(name);
    for (const dep of byName.get(name).dependsOn) visit(dep);
    visiting.delete(name);
    visited.add(name);
  };
  for (const task of state.tasks) visit(task.name);
  return state;
}

export function expireAgentLeases(state, nowMs = Date.now()) {
  validateAgentBoardState(state.boardId, state);
  let changed = false;
  for (const task of state.tasks) {
    if (task.state !== 'claimed' || !task.leaseExpiresAt) continue;
    const expires = Date.parse(task.leaseExpiresAt);
    if (!Number.isFinite(expires) || expires <= nowMs) {
      const priorAgent = task.agentId;
      task.state = 'pending';
      task.agentId = null;
      task.claimedAt = null;
      task.leaseExpiresAt = null;
      task.lastNote = 'lease expired';
      addEvent(state, { at: isoFromMs(nowMs), type: 'lease-expired', taskName: task.name, agentId: priorAgent });
      changed = true;
    }
  }
  if (changed) state.updatedAt = isoFromMs(nowMs);
  return changed;
}

function dependenciesDone(state, task) {
  const byName = new Map(state.tasks.map(item => [item.name, item]));
  return task.dependsOn.every(dep => byName.get(dep)?.state === 'done');
}

export function claimAgentTask(state, { agentId, taskName = null, leaseSeconds = null, nowMs = Date.now() }) {
  validateAgentBoardState(state.boardId, state);
  expireAgentLeases(state, nowMs);
  const agent = assertAgentId(agentId);
  const lease = normalizeLeaseSeconds(leaseSeconds);

  const existing = state.tasks.find(task => task.state === 'claimed' && task.agentId === agent);
  if (existing) throw new Error('agent sudah memiliki task aktif: ' + existing.name);

  let task;
  if (taskName != null) {
    const name = assertWorkspaceTaskName(taskName, 'taskName');
    task = state.tasks.find(item => item.name === name);
    if (!task) throw new Error('task tidak ditemukan: ' + name);
    if (task.state !== 'pending') throw new Error('task tidak tersedia: ' + name);
    if (!dependenciesDone(state, task)) throw new Error('dependency task belum selesai: ' + name);
  } else {
    task = state.tasks.find(item => item.state === 'pending' && dependenciesDone(state, item));
    if (!task) throw new Error('tidak ada task ready untuk di-claim');
  }

  const at = isoFromMs(nowMs);
  task.state = 'claimed';
  task.agentId = agent;
  task.claimedAt = at;
  task.leaseExpiresAt = isoFromMs(nowMs + lease * 1000);
  task.lastNote = null;
  state.updatedAt = at;
  addEvent(state, { at, type: 'claimed', taskName: task.name, agentId: agent });
  return task;
}

function requireClaimOwner(state, taskName, agentId, nowMs) {
  expireAgentLeases(state, nowMs);
  const name = assertWorkspaceTaskName(taskName, 'taskName');
  const agent = assertAgentId(agentId);
  const task = state.tasks.find(item => item.name === name);
  if (!task) throw new Error('task tidak ditemukan: ' + name);
  if (task.state !== 'claimed' || task.agentId !== agent) throw new Error('task tidak sedang di-claim oleh agent ini');
  return { task, agent };
}

export function heartbeatAgentTask(state, { agentId, taskName, leaseSeconds = null, nowMs = Date.now() }) {
  validateAgentBoardState(state.boardId, state);
  const { task, agent } = requireClaimOwner(state, taskName, agentId, nowMs);
  const lease = normalizeLeaseSeconds(leaseSeconds);
  const at = isoFromMs(nowMs);
  task.leaseExpiresAt = isoFromMs(nowMs + lease * 1000);
  state.updatedAt = at;
  addEvent(state, { at, type: 'heartbeat', taskName: task.name, agentId: agent });
  return task;
}

function normalizeEvidence(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('evidence harus array maksimum 20 item');
  return value.map((item, index) => assertMultilineString(item, 'evidence[' + index + ']', 1, 500));
}

export function submitAgentTask(state, { agentId, taskName, summary, commit = null, evidence = null, nowMs = Date.now() }) {
  validateAgentBoardState(state.boardId, state);
  const { task, agent } = requireClaimOwner(state, taskName, agentId, nowMs);
  const safeSummary = assertMultilineString(summary, 'summary', 1, 2400);
  let safeCommit = null;
  if (commit != null) {
    if (typeof commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error('commit tidak valid');
    safeCommit = commit;
  }
  const safeEvidence = normalizeEvidence(evidence);
  const at = isoFromMs(nowMs);
  task.state = 'done';
  task.completedAt = at;
  task.leaseExpiresAt = null;
  task.commit = safeCommit;
  task.summary = safeSummary;
  task.evidence = safeEvidence;
  task.lastNote = null;
  state.updatedAt = at;
  addEvent(state, { at, type: 'submitted', taskName: task.name, agentId: agent, commit: safeCommit });
  return task;
}

export function releaseAgentTask(state, { agentId, taskName, note = null, nowMs = Date.now() }) {
  validateAgentBoardState(state.boardId, state);
  const { task, agent } = requireClaimOwner(state, taskName, agentId, nowMs);
  const safeNote = note == null ? null : assertMultilineString(note, 'note', 1, 1000);
  const at = isoFromMs(nowMs);
  task.state = 'pending';
  task.agentId = null;
  task.claimedAt = null;
  task.leaseExpiresAt = null;
  task.lastNote = safeNote;
  state.updatedAt = at;
  addEvent(state, { at, type: 'released', taskName: task.name, agentId: agent, note: safeNote });
  return task;
}

export function summarizeAgentBoard(state, nowMs = Date.now()) {
  validateAgentBoardState(state.boardId, state);
  expireAgentLeases(state, nowMs);
  const counts = { pending: 0, claimed: 0, done: 0, ready: 0 };
  for (const task of state.tasks) {
    counts[task.state]++;
    if (task.state === 'pending' && dependenciesDone(state, task)) counts.ready++;
  }
  return {
    boardId: state.boardId,
    workspaceId: state.workspaceId,
    projectId: state.projectId || null,
    repoPath: state.repoPath,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    counts,
    tasks: state.tasks,
    recentEvents: (state.events || []).slice(-20)
  };
}

export function canRemoveAgentBoard(state, nowMs = Date.now()) {
  validateAgentBoardState(state.boardId, state);
  expireAgentLeases(state, nowMs);
  return state.tasks.every(task => task.state === 'done');
}

export function assertAgentBoardWorkspaceMapping(state, workspaceManifest) {
  validateAgentBoardState(state.boardId, state);
  if (!workspaceManifest || workspaceManifest.workspaceId !== state.workspaceId || (workspaceManifest.projectId || null) !== (state.projectId || null) || workspaceManifest.repoPath !== state.repoPath || !Array.isArray(workspaceManifest.tasks)) {
    throw new Error('agent board tidak cocok dengan workspace aktual');
  }
  const workspaceByName = new Map(workspaceManifest.tasks.map(task => [task.name, task]));
  for (const task of state.tasks) {
    const actual = workspaceByName.get(task.name);
    if (!actual ||
        actual.branch !== task.branch ||
        actual.baseRef !== task.baseRef ||
        actual.worktreePath !== task.worktreePath) {
      throw new Error('mapping task agent board berbeda dari workspace aktual: ' + task.name);
    }
  }
  return true;
}
