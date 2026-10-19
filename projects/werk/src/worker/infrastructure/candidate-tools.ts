import { containsSensitivePatchMaterial } from '../application/review-patch-policy.js';
import { runApprovedToolProcess } from './tool-process.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ProcessRunError } from '../../shared/process/launcher.js';
import type { DevelopmentFactory, DevelopmentEvidence, DevelopmentCandidate, DevelopmentCheckEvidence } from '../application/development.js';
import { assertDevelopmentPolicy, validateDevelopmentState } from '../application/development.js';
import { approvedFolder, approvedPathMatch, validateApprovedPaths } from '../application/approved-paths.js';
import { candidateGitOutputBytes, RepositoryGitError, repositoryGit } from './repositories-git.js';
import { syncDirectory } from './journal/files.js';
import { resolveCandidateInspectionLimits, resolveCandidateReviewLimits, resolveCommandTimeoutMs } from '../application/tool-limits.js';

export class CandidateToolError extends Error {}
/** Internal: sizes of reviewed approved files, for the apply-time total. Never part of evidence or tool output. */
type InspectedCandidate = DevelopmentCandidate & { reviewedSizes: Record<string, number> };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const empty = (): DevelopmentEvidence => ({ schemaVersion: 1, candidateDigest: null, changedPaths: [], checks: [], updatedAt: new Date().toISOString() });
function fail(message: string): never { throw new CandidateToolError(message); }
const below = (root: string, target: string) => { const path = relative(root, target); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const safeRelative = (path: string) => !!path && !isAbsolute(path) && !path.includes('\\') && !path.includes(':') && !path.includes('\0') && path.split('/').every(part => !!part && part !== '..' && part !== '.' && part.toLowerCase() !== '.git');
const count = (value: number) => value.toLocaleString('en-US');
const cleanOutput = (bytes: Buffer) => bytes.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 4096);

/** Lazy, private worktree adapter. The application supplies retained ownership verification and durable evidence storage. */
export const createDevelopmentRuntime: DevelopmentFactory = options => {
  validateDevelopmentState(options.scope, options.initialEvidence);
  const scope = structuredClone(options.scope);
  // Implementation scopes may approve folders: safe paths below them are approved, everything else stays outside.
  const approved = validateApprovedPaths(scope.approvedPaths, 'Approved paths', { folders: true });
  const exact = approved.filter(path => !approvedFolder(path));
  const isApproved = (path: string) => approvedPathMatch(approved, path);
  const root = resolve(options.worktree);
  // Frozen with the attempt's dispatch; every tracked and non-ignored file is still read and fingerprinted.
  const limits = resolveCandidateInspectionLimits(options), review = resolveCandidateReviewLimits(options);
  // File listings scale with the frozen file limit: allow an average of 4 KiB per path, from the default up to 1 GiB.
  const listingBytes = candidateGitOutputBytes(limits);
  const listing = (args: string[], signal: AbortSignal) => repositoryGit(root, args, signal, 30000, listingBytes).then(output => output.split('\0').filter(Boolean), error => {
    if (error instanceof RepositoryGitError && error.outputLimit) fail(`Candidate file list exceeds ${count(listingBytes)} bytes; raise execution.candidateSourceMaxFiles or reduce tracked files.`);
    throw error;
  });
  const sourceBytesError = (size: number) => `Candidate source is ${count(size)} bytes; the inspection limit is ${count(limits.candidateSourceMaxBytes)} bytes (execution.candidateSourceMaxBytes).`;
  const approvedTotalError = (size: number) => `Approved candidate text is ${count(size)} bytes; the approved content limit is ${count(review.candidateApprovedTotalMaxBytes)} bytes (execution.candidateApprovedTotalMaxBytes).`;
  const approvedFileError = (path: string, size: number) => `Approved candidate file ${JSON.stringify(path)} is ${count(size)} bytes; the approved file limit is ${count(review.candidateApprovedFileMaxBytes)} bytes (execution.candidateApprovedFileMaxBytes).`;
  const patchError = (size: string) => `Candidate review patch is ${size} bytes; the review patch limit is ${count(review.candidateReviewPatchMaxBytes)} bytes (execution.candidateReviewPatchMaxBytes).`;
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
  /** Reviewed approved text uses the frozen approved file bound; other source files use the frozen per-file inspection limit. */
  const tooLarge = (path: string, size: number, limit: number, reviewed: boolean) => reviewed ? approvedFileError(path, size)
    : `Candidate file ${JSON.stringify(path)} is ${count(size)} bytes; the per-file inspection limit is ${count(limit)} bytes (execution.candidateFileMaxBytes).`;
  async function bytes(path: string, limit: number, reviewed = false): Promise<{ body: Buffer; mode: number } | null> {
    const target = await pathFor(path, true);
    const before = await lstat(target).catch(error => { if (missing(error)) return null; throw error; });
    if (!before) return null;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('Candidate files must be ordinary files without symbolic or hard links.');
    if (before.size > limit) fail(tooLarge(path, before.size, limit, reviewed));
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      const current = await lstat(await pathFor(path, false));
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || current.dev !== opened.dev || current.ino !== opened.ino) fail('Candidate file changed during inspection.');
      const buffer = Buffer.alloc(Math.min(limit + 1, opened.size + 1));
      let size = 0;
      while (size < buffer.length) { const part = await handle.read(buffer, size, buffer.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
      if (size > limit) fail(tooLarge(path, Math.max(size, opened.size), limit, reviewed));
      const after = await handle.stat();
      if (after.size !== size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('Candidate file changed during inspection.');
      return { body: buffer.subarray(0, size), mode: opened.mode & 0o777 };
    } finally { await handle.close(); }
  }
  /** Reports the whole size once a limit is exceeded, so one settings change suffices; unread files are measured, not read. */
  async function sizeOnDisk(rest: string[], signal: AbortSignal) {
    let size = 0;
    for (const path of rest) {
      signal.throwIfAborted();
      const target = await pathFor(path, true);
      const info = await lstat(target).catch(error => { if (missing(error)) return null; throw error; });
      signal.throwIfAborted();
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) fail('Candidate files must be ordinary files without symbolic or hard links.');
      size += info?.size ?? 0;
    }
    await rootIdentity(); authorize(signal);
    return size;
  }
  function text(body: Buffer) {
    if (body.includes(0)) fail('Approved candidate files must contain UTF-8 text.');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { return fail('Approved candidate files must contain UTF-8 text.'); }
  }
  /**
   * Exact approved files are always reviewed text. Below an approved folder, every safe file is listed with its hash for
   * edits, while only changed, added or deleted files count as reviewed text; unchanged ones are ordinary inspected source.
   */
  async function inspectOnce(signal: AbortSignal): Promise<InspectedCandidate> {
    await guard(signal);
    const changed = await listing(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', scope.baseCommit, '--'], signal);
    const untracked = await listing(['ls-files', '-z', '--others', '--exclude-standard'], signal);
    const outside = [...changed, ...untracked].find(path => !isApproved(path));
    if (outside !== undefined) fail(`The worktree contains changes outside the approved paths, including ${JSON.stringify(outside)}. Inspect them before continuing; they will not be published.`);
    const tracked = await listing(['ls-files', '-z', '--cached'], signal);
    const flags = await listing(['ls-files', '-v', '-z'], signal);
    if (flags.some(entry => !entry.startsWith('H '))) fail('Candidate index flags changed. Hidden or sparse changes cannot be verified.');
    const paths = [...new Set([...tracked, ...untracked, ...exact])].sort();
    if (paths.length > limits.candidateSourceMaxFiles) fail(`Candidate source has ${count(paths.length)} files; the inspection limit is ${count(limits.candidateSourceMaxFiles)} files (execution.candidateSourceMaxFiles).`);
    const touched = new Set([...changed, ...untracked]), trackedSet = new Set(tracked);
    const reviewed = (path: string) => exact.includes(path) || touched.has(path);
    const digest = createHash('sha256').update(JSON.stringify(['werk-candidate-v1', scope.baseCommit]));
    const files: { path: string; hash: string | null }[] = [];
    const additions: { path: string; content: string; mode: number }[] = [];
    const reviewedSizes: Record<string, number> = {};
    let total = 0, approvedTotal = 0;
    for (const [index, path] of paths.entries()) {
      signal.throwIfAborted();
      const counted = reviewed(path);
      const value = await bytes(path, counted ? review.candidateApprovedFileMaxBytes : limits.candidateFileMaxBytes, counted);
      total += value?.body.length ?? 0;
      if (total > limits.candidateSourceMaxBytes) fail(sourceBytesError(total + await sizeOnDisk(paths.slice(index + 1), signal)));
      const fileHash = value ? hash(value.body) : null;
      digest.update(JSON.stringify([path, value?.mode ?? null, fileHash]));
      if (isApproved(path)) files.push({ path, hash: fileHash });
      if (!counted) continue;
      reviewedSizes[path] = value?.body.length ?? 0;
      approvedTotal += reviewedSizes[path];
      if (approvedTotal > review.candidateApprovedTotalMaxBytes) fail(approvedTotalError(approvedTotal + await sizeOnDisk(paths.slice(index + 1).filter(reviewed), signal)));
      if (value) {
        const content = text(value.body);
        if (!trackedSet.has(path)) additions.push({ path, content, mode: value.mode });
      }
    }
    // Folder entries are Git directory pathspecs; every changed path below them was approved above.
    const patchBytes = Math.max(2 * 1024 * 1024, review.candidateReviewPatchMaxBytes + 1);
    let patch = await repositoryGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--src-prefix=a/', '--dst-prefix=b/', scope.baseCommit, '--', ...approved], signal, 30000, patchBytes).catch(error => {
      if (error instanceof RepositoryGitError && error.outputLimit) fail(patchError('more than ' + count(patchBytes - 1)));
      throw error;
    });
    for (const file of additions) {
      const lines = file.content ? file.content.split('\n') : [];
      const finalNewline = file.content.endsWith('\n'); if (finalNewline) lines.pop();
      patch += `diff --git ${JSON.stringify('a/' + file.path)} ${JSON.stringify('b/' + file.path)}\nnew file mode ${file.mode & 0o111 ? '100755' : '100644'}\n`;
      if (lines.length) patch += `--- /dev/null\n+++ ${JSON.stringify('b/' + file.path)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n${finalNewline ? '' : '\\ No newline at end of file\n'}`;
    }
    const patchSize = Buffer.byteLength(patch);
    if (patchSize > review.candidateReviewPatchMaxBytes) fail(patchError(count(patchSize)));
    // Preserve the same review-leak guard used by legacy proposal patches.
    if (containsSensitivePatchMaterial(patch)) fail('Candidate patch contains sensitive material and cannot be published for review.');
    await rootIdentity(); authorize(signal);
    return { patch, digest: digest.digest('hex'), changedPaths: [...new Set([...changed, ...additions.map(file => file.path)])].sort(), files, reviewedSizes };
  }
  async function inspect(signal: AbortSignal): Promise<InspectedCandidate> {
    const first = await inspectOnce(signal), second = await inspectOnce(signal);
    if (first.digest !== second.digest || first.patch !== second.patch) fail('Candidate source changed during inspection. Retry after external edits finish.');
    return second;
  }
  const editLimit = Math.max(review.candidateApprovedFileMaxBytes, limits.candidateFileMaxBytes);
  const updated = (candidate: DevelopmentCandidate, checks = state.checks): DevelopmentEvidence => ({ schemaVersion: 1, candidateDigest: candidate.digest, changedPaths: [...candidate.changedPaths], checks, updatedAt: new Date().toISOString() });
  async function capture(signal: AbortSignal) {
    const candidate = await inspect(signal);
    if (state.candidateDigest !== candidate.digest) await checkpoint(updated(candidate, []));
    return candidate;
  }
  return {
    evidence: () => structuredClone(state),
    prepareNative: signal => serial(async () => {
      const candidate = await inspect(signal);
      await checkpoint(updated(candidate, []));
      await guard(signal);
    }),
    capture: signal => serial(() => capture(signal)),
    apply: (input, signal) => serial(async () => {
      await guard(signal);
      if (!input || typeof input.path !== 'string' || !isApproved(input.path) || input.content !== null && typeof input.content !== 'string' || !Object.hasOwn(input, 'expectedHash') || input.expectedHash !== null && !/^[a-f0-9]{64}$/.test(input.expectedHash ?? '')) fail('Apply one explicitly approved path (an approved file, or a safe file below an approved folder ending in /) with content (or null to delete) and its current expectedHash from candidate status.');
      const before = await inspect(signal);
      // Files below an approved folder that do not exist yet have no status entry; their current hash is null.
      const current = before.files!.find(file => file.path === input.path)?.hash ?? null;
      if (current !== input.expectedHash) fail('Candidate content changed. Read candidate status and retry with its current hash.');
      const body = input.content === null ? null : Buffer.from(input.content, 'utf8');
      if (body?.includes(0)) fail('Candidate content must be UTF-8 text without NUL characters.');
      if (body && body.length > review.candidateApprovedFileMaxBytes) fail(approvedFileError(input.path, body.length));
      const approvedSize = Object.entries(before.reviewedSizes).reduce((sum, [path, size]) => path === input.path ? sum : sum + size, body?.length ?? 0);
      if (approvedSize > review.candidateApprovedTotalMaxBytes) fail(approvedTotalError(approvedSize));
      // Inspection already bounded the current file; edits re-read it to compare hashes.
      const target = await pathFor(input.path, true);
      let parent = root;
      for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
        parent = join(parent, part);
        await mkdir(parent, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        await pathFor(relative(root, parent).split(sep).join('/'), false);
      }
      const reread = await bytes(input.path, editLimit);
      if ((reread ? hash(reread.body) : null) !== input.expectedHash) fail('Candidate content changed before the edit; retry with its current hash.');
      authorize(signal); await rootIdentity();
      // Invalidate old successful checks durably before any filesystem mutation.
      await checkpoint({ ...state, checks: [], updatedAt: new Date().toISOString() });
      authorize(signal); await rootIdentity();
      const ready = await bytes(input.path, editLimit);
      if ((ready ? hash(ready.body) : null) !== input.expectedHash) fail('Candidate content changed while saving evidence; retry with its current hash.');
      if (body === null) {
        if (reread) await unlink(await pathFor(input.path, false));
      } else {
        const temporary = join(dirname(target), '.werk-candidate-' + randomUUID() + '.tmp');
        const handle = await open(temporary, 'wx', reread?.mode ?? 0o600);
        try {
          await handle.writeFile(body); await handle.sync(); await handle.close();
          await pathFor(input.path, true); await rootIdentity(); authorize(signal);
          const latest = await bytes(input.path, editLimit);
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
        const result = await runApprovedToolProcess(preset.executable, preset.args, { cwd: root, signal, timeoutMs: resolveCommandTimeoutMs(options.commandTimeoutMs, preset.timeoutMs), maxOutputBytes: 32768 });
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
