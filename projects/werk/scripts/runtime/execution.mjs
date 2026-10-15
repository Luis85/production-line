import { posix, isAbsolute, resolve } from 'node:path';

const fail = () => { throw Object.assign(Error('Invalid live execution configuration. Use native Linux, exact absolute Codex/repository paths and 1–32 approved non-secret relative text paths.'), { exitCode: 2 }); };
/** Operator deployment policy only. Tasks cannot select executable, checkout or allowed paths. */
export function normalizeExecution(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['mode', 'timeoutMs', 'codex'].includes(key)) || value.mode !== 'cli') fail();
  const codex = value.codex;
  if (!codex || typeof codex !== 'object' || Array.isArray(codex) || Object.keys(codex).some(key => !['executable', 'repository', 'allowedPaths'].includes(key))) fail();
  for (const key of ['executable', ...(codex.repository === undefined ? [] : ['repository'])]) if (typeof codex[key] !== 'string' || !posix.isAbsolute(codex[key]) || codex[key].length > 4096 || /[\x00-\x1f\x7f]/.test(codex[key])) fail();
  const paths = codex.allowedPaths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 32 || new Set(paths).size !== paths.length || paths.some(path => typeof path !== 'string' || path.length > 240 || !/^[a-zA-Z0-9_./ -]+$/.test(path) || path.startsWith('-') || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || /(?:^|\/)(?:credentials?|secrets?|id_rsa|id_ed25519)(?:[./]|$)/i.test(path) || /\.(?:pem|key|p12|pfx)$/i.test(path))) fail();
  const timeoutMs = value.timeoutMs ?? 300000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) fail();
  return { mode: 'cli', timeoutMs, codex: { executable: codex.executable, ...(codex.repository === undefined ? {} : { repository: codex.repository }), allowedPaths: [...paths] } };
}
export function workerDocument(execution, chat, repositories) {
  const normalized = normalizeExecution(execution);
  const conversation = normalizeChat(chat);
  const assignments = normalizeRepositories(repositories);
  if (normalized && !normalized.codex.repository && !assignments?.items.length) fail();
  const document = normalized ? { schemaVersion: 1, execution: normalized, scheduler: { maxParallel: 1, maxAttempts: 1 }, profiles: [{ id: 'codex-live', provider: 'codex', mode: 'cli', maxParallel: 1 }] } : undefined;
  return conversation || assignments ? { ...document, ...(conversation ? { chat: conversation } : {}), ...(assignments ? { repositories: assignments } : {}) } : document;
}

/** Chat can use a real model while task execution remains simulated. */
export function normalizeChat(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.codexExecutable !== 'string' || !posix.isAbsolute(value.codexExecutable) || value.codexExecutable.length > 4096 || /[\x00-\x1f\x7f]/.test(value.codexExecutable)) throw Object.assign(Error('chat.codexExecutable must be an absolute Linux path.'), { exitCode: 2 });
  return { codexExecutable: value.codexExecutable };
}

/** Deployment policy: existing checkout paths only; Git access is checked by the worker. */
export function normalizeRepositories(value) {
  if (value === undefined) return undefined;
  const invalid = () => { throw Object.assign(Error('Invalid repository assignments. Use unique ids and absolute checkout paths, Git remote/branch names and a bounded polling interval.'), { exitCode: 2 }); };
  const object = (input, keys) => { if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.keys(input).some(key => !keys.includes(key))) invalid(); return input; };
  const text = (input, max) => { if (typeof input !== 'string' || !input.trim() || input.length > max) invalid(); return input.trim(); };
  object(value, ['pollMs', 'items']);
  const pollMs = value.pollMs ?? 30000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 3600000) invalid();
  const entries = value.items === undefined ? [] : value.items;
  if (!Array.isArray(entries) || entries.length > 64) invalid();
  const ids = new Set(), paths = new Set();
  const items = entries.map(input => {
    const item = object(input, ['id', 'path', 'remote', 'branch', 'watch']);
    const id = text(item.id, 100), source = text(item.path, 4096);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !isAbsolute(source) || /[\x00-\x1f\x7f]/.test(source)) invalid();
    const path = resolve(source), remote = item.remote === undefined ? 'origin' : text(item.remote, 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) || remote.includes('..') || remote.endsWith('.lock')) invalid();
    const watch = item.watch === undefined ? true : item.watch;
    if (typeof watch !== 'boolean') invalid();
    const branch = item.branch === undefined ? undefined : text(item.branch, 200);
    if (branch !== undefined && (branch === '@' || branch.startsWith('-') || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') || branch.endsWith('.') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')))) invalid();
    if (ids.has(id) || paths.has(path)) invalid();
    ids.add(id); paths.add(path);
    return { id, path, remote, ...(branch ? { branch } : {}), watch };
  });
  return { pollMs, items };
}
