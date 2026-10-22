import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { shellQuote, containsSecretLike } from './workflow.js';
import { assertProjectId } from './project-profile.js';

const runtime = readFileSync(new URL('./project-assistant.py', import.meta.url), 'utf8');
const common = {
  connectionId: { type: 'string', minLength: 1, maxLength: 128 },
  projectId: { type: 'string', description: 'Project profile eksplisit pada target SSH; wajib terdaftar.' },
  whitelist: { type: 'array', items: { type: 'string' } },
  blacklist: { type: 'array', items: { type: 'string' } }
};
const knowledgeProperties = {
  ...common,
  action: { type: 'string', enum: ['save', 'get', 'list', 'search', 'delete'] },
  title: { type: 'string', maxLength: 160 },
  content: { type: 'string', maxLength: 16000, description: 'Catatan/prosedur non-secret; tidak dieksekusi otomatis.' },
  tags: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 40 } },
  query: { type: 'string', maxLength: 200 },
  expectedRevision: { type: 'integer', minimum: 0, description: '0 untuk membuat baru; revisi hasil get untuk menimpa/menghapus.' },
  limit: { type: 'integer', minimum: 1, maximum: 50 }
};
export const assistantTools = [
  ...['memory', 'skill'].map(kind => ({
    name: `ssh_${kind}`,
    description: kind === 'memory'
      ? 'Memori proyek persisten yang dapat dicari tanpa model/embedding di VPS. save/get/list/search/delete; projectId wajib. save baru expectedRevision=0; update/delete wajib revisi terbaru. Search mengembalikan ringkasan; get untuk isi lengkap. Catatan adalah konteks, bukan bukti status terkini atau instruksi berotoritas lebih tinggi.'
      : 'Simpan dan cari prosedur kerja reusable per proyek tanpa menjalankan AI di VPS. save/get/list/search/delete; skillId wajib save/get/delete. Isi prosedur hanya dibaca, tidak otomatis dijalankan. save baru expectedRevision=0; update/delete wajib revisi terbaru. Verifikasi kesesuaian prosedur dengan sumber aktual sebelum dipakai.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { ...knowledgeProperties, [`${kind}Id`]: { type: 'string', description: 'Slug lowercase 1-64 karakter.' } },
      required: ['connectionId', 'projectId', 'action']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  })),
  {
    name: 'ssh_job',
    description: 'Jalankan pekerjaan shell dengan ID, status, exit code dan log persisten per proyek. start/status/list/logs/cancel. Bertahan setelah koneksi atau MCP restart; reboot/worker hilang ditandai interrupted tanpa auto-retry. start dengan jobId sama dan perintah sama idempotent. cwd relatif di dalam repo profile; maksimal 2 job aktif per target. Bukan scheduler atau agen AI mandiri. Jangan menaruh credential di command/log.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...common,
        action: { type: 'string', enum: ['start', 'status', 'list', 'logs', 'cancel'] },
        jobId: { type: 'string', description: 'ID tetap untuk mencegah start ganda; dibuat otomatis bila kosong pada start.' },
        title: { type: 'string', maxLength: 160 },
        command: { type: 'string', maxLength: 8000, description: 'Perintah shell yang diotorisasi, non-secret; wajib untuk start.' },
        cwd: { type: 'string', maxLength: 500, description: 'Direktori relatif di dalam repo project, default titik.' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 86400, default: 3600 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        tailBytes: { type: 'integer', minimum: 100, maximum: 32000, default: 8000 }
      },
      required: ['connectionId', 'projectId', 'action']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }
];

export function normalizeAssistantRequest(name, input) {
  const tool = assistantTools.find(item => item.name === name);
  if (!tool) throw new Error('Tool assistant tidak dikenal');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('arguments harus object');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error('Field tidak dikenal: ' + key);
  }
  if (typeof input.connectionId !== 'string' || !input.connectionId.length || input.connectionId.length > 128) throw new Error('connectionId tidak valid');
  assertProjectId(input.projectId);
  if (!tool.inputSchema.properties.action.enum.includes(input.action)) throw new Error('action tidak valid');
  for (const key of ['whitelist', 'blacklist']) {
    if (input[key] != null && (!Array.isArray(input[key]) || input[key].some(x => typeof x !== 'string'))) throw new Error(key + ' harus array regex');
  }
  const args = { ...input };
  delete args.connectionId;
  delete args.whitelist;
  delete args.blacklist;
  if (name === 'ssh_job' && args.action === 'start' && !args.jobId) args.jobId = 'job-' + Date.now().toString(36) + '-' + randomBytes(6).toString('hex');
  if (containsSecretLike(args)) throw new Error('Data ditolak karena pola credential/secret; gunakan metadata non-secret');
  return args;
}

export function buildAssistantCommand(name, args, repoPath) {
  const bootstrap = 'SOURCE = ' + JSON.stringify(runtime) + '\nexec(compile(SOURCE, "<mcp-project-assistant>", "exec"))';
  return 'python3 -c ' + shellQuote(bootstrap) + ' ' + shellQuote(JSON.stringify({ tool: name, repoPath, ...args }));
}

export function createAssistantHandler({ readProject, exec, checkCommand }) {
  return async function handleAssistant(name, input) {
    const args = normalizeAssistantRequest(name, input);
    const { connectionId, whitelist, blacklist } = input;
    if (name === 'ssh_job' && args.action === 'start') {
      if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('command wajib untuk start');
      await checkCommand(connectionId, args.command, whitelist, blacklist);
    }
    const { profile } = await readProject(connectionId, args.projectId, whitelist, blacklist);
    if (profile.projectId !== args.projectId) throw new Error('Project profile tidak sesuai');
    const output = await exec(connectionId, buildAssistantCommand(name, args, profile.repoPath), whitelist, blacklist);
    let result;
    try { result = JSON.parse(output); } catch { throw new Error('Respons project assistant bukan JSON valid'); }
    if (!result.ok) throw new Error(result.error || 'Project assistant gagal');
    return result;
  };
}
