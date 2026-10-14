import { posix } from 'node:path';

const fail = () => { throw Object.assign(Error('Invalid live execution configuration. Use native Linux, exact absolute Codex/repository paths and 1–32 approved non-secret relative text paths.'), { exitCode: 2 }); };
/** Operator deployment policy only. Tasks cannot select executable, checkout or allowed paths. */
export function normalizeExecution(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['mode', 'timeoutMs', 'codex'].includes(key)) || value.mode !== 'cli') fail();
  const codex = value.codex;
  if (!codex || typeof codex !== 'object' || Array.isArray(codex) || Object.keys(codex).some(key => !['executable', 'repository', 'allowedPaths'].includes(key))) fail();
  for (const key of ['executable', 'repository']) if (typeof codex[key] !== 'string' || !posix.isAbsolute(codex[key]) || codex[key].length > 4096 || /[\x00-\x1f\x7f]/.test(codex[key])) fail();
  const paths = codex.allowedPaths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 32 || new Set(paths).size !== paths.length || paths.some(path => typeof path !== 'string' || path.length > 240 || !/^[a-zA-Z0-9_./ -]+$/.test(path) || path.startsWith('-') || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || /(?:^|\/)(?:credentials?|secrets?|id_rsa|id_ed25519)(?:[./]|$)/i.test(path) || /\.(?:pem|key|p12|pfx)$/i.test(path))) fail();
  const timeoutMs = value.timeoutMs ?? 300000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) fail();
  return { mode: 'cli', timeoutMs, codex: { executable: codex.executable, repository: codex.repository, allowedPaths: [...paths] } };
}
export function workerDocument(execution, chat) {
  const normalized = normalizeExecution(execution);
  const conversation = normalizeChat(chat);
  const document = normalized ? { schemaVersion: 1, execution: normalized, scheduler: { maxParallel: 1, maxAttempts: 1 }, profiles: [{ id: 'codex-live', provider: 'codex', mode: 'cli', maxParallel: 1 }] } : undefined;
  return conversation ? { ...document, chat: conversation } : document;
}

/** Chat can use a real model while task execution remains simulated. */
export function normalizeChat(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.codexExecutable !== 'string' || !posix.isAbsolute(value.codexExecutable) || value.codexExecutable.length > 4096 || /[\x00-\x1f\x7f]/.test(value.codexExecutable)) throw Object.assign(Error('chat.codexExecutable must be an absolute Linux path.'), { exitCode: 2 });
  return { codexExecutable: value.codexExecutable };
}
