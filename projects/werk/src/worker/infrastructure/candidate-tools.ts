import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ProcessRunError, runProcess } from '../../shared/process/launcher.js';
import type { DevelopmentFactory, DevelopmentEvidence, DevelopmentCandidate, DevelopmentCheckEvidence } from '../application/development.js';
import { assertDevelopmentPolicy, validateDevelopmentState } from '../application/development.js';
import { validateApprovedPaths } from '../application/approved-paths.js';
import { repositoryGit } from './repositories-git.js';
import { syncDirectory } from './journal/files.js';
import { DEFAULT_COMMAND_TIMEOUT_MS } from '../application/execution-policy.js';

export class CandidateToolError extends Error {}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const empty = (): DevelopmentEvidence => ({ schemaVersion: 1, candidateDigest: null, changedPaths: [], checks: [], updatedAt: new Date().toISOString() });
function fail(message: string): never { throw new CandidateToolError(message); }
const below = (root: string, target: string) => { const path = relative(root, target); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const safeRelative = (path: string) => !!path && !isAbsolute(path) && !path.includes('\\') && !path.includes(':') && !path.includes('\0') && path.split('/').every(part => !!part && part !== '..' && part !== '.' && part.toLowerCase() !== '.git');
const cleanOutput = (bytes: Buffer) => bytes.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 4096);

/** Lazy, private worktree adapter. The application supplies retained ownership verification and durable evidence storage. */
export const createDevelopmentRuntime: DevelopmentFactory = options => {
  validateDevelopmentState(options.scope, options.initialEvidence);
  const scope = structuredClone(options.scope);
  const approved = validateApprovedPaths(scope.approvedPaths);
  const root = resolve(options.worktree);
  let state = structuredClone(options.initialEvidence ?? empty());
  let broken = false;
  let previous: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => { const result = previous.then(operation); previous = result.catch(() => {}); return result; };
  async function rootIdentity() {
    const info = await lstat(root);
    const expected = options.worktreeIdentity;
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root || String(info.dev) !== expected.dev || String(info.ino) !== expected.ino || info.birthtimeMs !== expected.birthtimeMs || root === await realpath(options.repository)) fail('The retained candidate worktree changed. Create a new task.');
  }
  function authorize(signal: AbortSignal) {
    signal.throwIfAborted();
    if (broken) fail('Candidate evidence could not be saved. Resume from durable task state before continuing.');
    try { assertDevelopmentPolicy(scope, options.currentPolicy()); } catch { fail('The required file or verification grants changed. Create a new task with the current plan.'); }
  }
  async function guard(signal: AbortSignal) {
    authorize(signal);
    await rootIdentity();
    await options.verifyWorkspace(signal);
    await rootIdentity();
    authorize(signal);
  }
  async function checkpoint(next: DevelopmentEvidence) {
    try { await options.checkpoint(structuredClone(next)); state = next; }
    catch { broken = true; fail('Candidate evidence could not be saved. No verification success was acknowledged. Resume from durable task state.'); }
  }
  async function pathFor(path: string, allowMissing: boolean) {
    if (!safeRelative(path)) fail('Candidate paths must stay inside the worktree; Git metadata and links are excluded.');
    const target = resolve(root, path);
    if (!below(root, target)) fail('Candidate path is outside the approved worktree.');
    let current = root;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      const info = await lstat(current).catch(error => { if (missing(error)) return null; throw error; });
      if (!info) { if (allowMissing) return target; fail('Candidate source file disappeared during inspection.'); }
      if (info.isSymbolicLink() || index < parts.length - 1 && !info.isDirectory()) fail('Candidate paths cannot contain symbolic links or non-directory parents.');
    }
    if (await realpath(target) !== target) fail('Candidate path changed during inspection.');
    return target;
  }
  async function bytes(path: string, limit: number): Promise<{ body: Buffer; mode: number } | null> {
    const target = await pathFor(path, true);
    const before = await lstat(target).catch(error => { if (missing(error)) return null; throw error; });
    if (!before) return null;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('Candidate files must be ordinary files without symbolic or hard links.');
    if (before.size > limit) fail('Candidate source exceeds the bounded file inspection limit.');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      const current = await lstat(await pathFor(path, false));
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || current.dev !== opened.dev || current.ino !== opened.ino) fail('Candidate file changed during inspection.');
      const buffer = Buffer.alloc(Math.min(limit + 1, opened.size + 1));
      let size = 0;
      while (size < buffer.length) { const part = await handle.read(buffer, size, buffer.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
      if (size > limit) fail('Candidate source exceeds the bounded file inspection limit.');
      const after = await handle.stat();
      if (after.size !== size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('Candidate file changed during inspection.');
      return { body: buffer.subarray(0, size), mode: opened.mode & 0o777 };
    } finally { await handle.close(); }
  }
  function text(body: Buffer) {
    if (body.includes(0)) fail('Approved candidate files must contain UTF-8 text.');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { return fail('Approved candidate files must contain UTF-8 text.'); }
  }
  async function inspectOnce(signal: AbortSignal): Promise<DevelopmentCandidate> {
    await guard(signal);
    const changed = (await repositoryGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', scope.baseCommit, '--'], signal)).split('\0').filter(Boolean);
    const untracked = (await repositoryGit(root, ['ls-files', '-z', '--others', '--exclude-standard'], signal)).split('\0').filter(Boolean);
    if ([...changed, ...untracked].some(path => !approved.includes(path))) fail('The worktree contains changes outside the approved paths. Inspect them before continuing; they will not be published.');
    const tracked = (await repositoryGit(root, ['ls-files', '-z', '--cached'], signal)).split('\0').filter(Boolean);
    const flags = (await repositoryGit(root, ['ls-files', '-v', '-z'], signal)).split('\0').filter(Boolean);
    if (flags.some(entry => !entry.startsWith('H '))) fail('Candidate index flags changed. Hidden or sparse changes cannot be verified.');
    const paths = [...new Set([...tracked, ...untracked, ...approved])].sort();
    if (paths.length > 20000) fail('Candidate source exceeds the 20,000-file inspection limit.');
    const digest = createHash('sha256').update(JSON.stringify(['werk-candidate-v1', scope.baseCommit]));
    const files: { path: string; hash: string | null }[] = [];
    const additions: { path: string; content: string; mode: number }[] = [];
    let total = 0, approvedTotal = 0;
    for (const path of paths) {
      signal.throwIfAborted();
      const value = await bytes(path, approved.includes(path) ? 24000 : 8 * 1024 * 1024);
      total += value?.body.length ?? 0;
      if (total > 64 * 1024 * 1024) fail('Candidate source exceeds the 64 MiB inspection limit.');
      const fileHash = value ? hash(value.body) : null;
      digest.update(JSON.stringify([path, value?.mode ?? null, fileHash]));
      if (approved.includes(path)) {
        files.push({ path, hash: fileHash });
        approvedTotal += value?.body.length ?? 0;
        if (approvedTotal > 48000) fail('Approved candidate text exceeds the 48,000-byte limit.');
        if (value) {
          const content = text(value.body);
          if (!tracked.includes(path)) additions.push({ path, content, mode: value.mode });
        }
      }
    }
    let patch = await repositoryGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--src-prefix=a/', '--dst-prefix=b/', scope.baseCommit, '--', ...approved], signal);
    for (const file of additions) {
      const lines = file.content ? file.content.split('\n') : [];
      const finalNewline = file.content.endsWith('\n'); if (finalNewline) lines.pop();
      patch += `diff --git ${JSON.stringify('a/' + file.path)} ${JSON.stringify('b/' + file.path)}\nnew file mode ${file.mode & 0o111 ? '100755' : '100644'}\n`;
      if (lines.length) patch += `--- /dev/null\n+++ ${JSON.stringify('b/' + file.path)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n${finalNewline ? '' : '\\ No newline at end of file\n'}`;
    }
    if (Buffer.byteLength(patch) > 120000) fail('Candidate patch exceeds the bounded review size.');
    // Preserve the same review-leak guard used by legacy proposal patches.
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/.test(patch)) fail('Candidate patch contains sensitive material and cannot be published for review.');
    await rootIdentity(); authorize(signal);
    return { patch, digest: digest.digest('hex'), changedPaths: [...new Set([...changed, ...additions.map(file => file.path)])].sort(), files };
  }
  async function inspect(signal: AbortSignal): Promise<DevelopmentCandidate> {
    const first = await inspectOnce(signal), second = await inspectOnce(signal);
    if (first.digest !== second.digest || first.patch !== second.patch) fail('Candidate source changed during inspection. Retry after external edits finish.');
    return second;
  }
  const updated = (candidate: DevelopmentCandidate, checks = state.checks): DevelopmentEvidence => ({ schemaVersion: 1, candidateDigest: candidate.digest, changedPaths: [...candidate.changedPaths], checks, updatedAt: new Date().toISOString() });
  async function capture(signal: AbortSignal) {
    const candidate = await inspect(signal);
    if (state.candidateDigest !== candidate.digest) await checkpoint(updated(candidate, []));
    return candidate;
  }
  return {
    evidence: () => structuredClone(state),
    capture: signal => serial(() => capture(signal)),
    apply: (input, signal) => serial(async () => {
      await guard(signal);
      if (!input || !approved.includes(input.path) || input.content !== null && typeof input.content !== 'string' || !Object.hasOwn(input, 'expectedHash') || input.expectedHash !== null && !/^[a-f0-9]{64}$/.test(input.expectedHash ?? '')) fail('Apply one explicitly approved path with content (or null to delete) and its current expectedHash from candidate status.');
      const before = await inspect(signal);
      const current = before.files!.find(file => file.path === input.path)!;
      if (current.hash !== input.expectedHash) fail('Candidate content changed. Read candidate status and retry with its current hash.');
      const body = input.content === null ? null : Buffer.from(input.content, 'utf8');
      if (body && (body.length > 24000 || body.includes(0))) fail('Candidate content must be UTF-8 text of at most 24,000 bytes.');
      let approvedSize = body?.length ?? 0;
      for (const path of approved.filter(path => path !== input.path)) approvedSize += (await bytes(path, 24000))?.body.length ?? 0;
      if (approvedSize > 48000) fail('Approved candidate text exceeds the 48,000-byte limit.');
      const target = await pathFor(input.path, true);
      let parent = root;
      for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
        parent = join(parent, part);
        await mkdir(parent, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        await pathFor(relative(root, parent).split(sep).join('/'), false);
      }
      const reread = await bytes(input.path, 24000);
      if ((reread ? hash(reread.body) : null) !== input.expectedHash) fail('Candidate content changed before the edit; retry with its current hash.');
      authorize(signal); await rootIdentity();
      // Invalidate old successful checks durably before any filesystem mutation.
      await checkpoint({ ...state, checks: [], updatedAt: new Date().toISOString() });
      authorize(signal); await rootIdentity();
      const ready = await bytes(input.path, 24000);
      if ((ready ? hash(ready.body) : null) !== input.expectedHash) fail('Candidate content changed while saving evidence; retry with its current hash.');
      if (body === null) {
        if (reread) await unlink(await pathFor(input.path, false));
      } else {
        const temporary = join(dirname(target), '.werk-candidate-' + randomUUID() + '.tmp');
        const handle = await open(temporary, 'wx', reread?.mode ?? 0o600);
        try {
          await handle.writeFile(body); await handle.sync(); await handle.close();
          await pathFor(input.path, true); await rootIdentity(); authorize(signal);
          const latest = await bytes(input.path, 24000);
          if ((latest ? hash(latest.body) : null) !== input.expectedHash) fail('Candidate content changed before publication; retry with its current hash.');
          await rename(temporary, target);
        } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
      }
      await syncDirectory(dirname(target));
      const after = await inspect(signal); await checkpoint(updated(after, []));
      return { digest: after.digest, changedPaths: after.changedPaths, files: after.files };
    }),
    check: (presetId, signal) => serial(async () => {
      const preset = scope.checks.find(check => check.id === presetId);
      if (!preset) fail('Only the task\'s frozen required verification presets may be checked.');
      const before = await capture(signal);
      const startedAt = new Date().toISOString();
      let receipt: DevelopmentCheckEvidence = { presetId, presetFingerprint: preset.fingerprint, candidateDigest: before.digest, status: 'interrupted', exitCode: null, stdout: '', stderr: '', startedAt, finishedAt: startedAt };
      const retained = () => state.checks.filter(check => check.presetId !== presetId);
      await checkpoint(updated(before, [...retained(), receipt]));
      let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0), exitCode: number | null = null, stopped = '';
      try {
        authorize(signal); await rootIdentity();
        const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
        const result = await runProcess(preset.executable, preset.args, { cwd: root, env, mode: 'contained', signal, timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, maxOutputBytes: 32768, captureStderr: true, allowNonZeroExit: true });
        ({ stdout, stderr, exitCode } = result);
      } catch (error) {
        stopped = error instanceof ProcessRunError ? error.reason : 'unavailable';
        if (error instanceof ProcessRunError) ({ stdout, stderr, exitCode } = error.result);
      }
      let after: DevelopmentCandidate | undefined;
      try { after = await inspect(signal); } catch (error) { stopped ||= signal.aborted ? 'cancelled' : error instanceof CandidateToolError ? error.message : 'candidate inspection failed'; }
      const unchanged = after?.digest === before.digest;
      receipt = { ...receipt, status: !stopped && exitCode === 0 && unchanged ? 'passed' : signal.aborted || stopped === 'cancelled' ? 'interrupted' : 'failed', exitCode, stdout: cleanOutput(stdout), truncated: stdout.length > 4096 || stderr.length > 4096 || stopped === 'output_limit', stderr: [cleanOutput(stderr), stopped ? `Verification stopped: ${stopped}.` : !unchanged ? 'Verification changed candidate source; rerun after inspecting the changes.' : ''].filter(Boolean).join('\n'), finishedAt: new Date().toISOString() };
      await checkpoint({ ...(after ? updated(after) : state), checks: [...retained(), receipt], updatedAt: receipt.finishedAt });
      return structuredClone(receipt);
    }),
  };
};
