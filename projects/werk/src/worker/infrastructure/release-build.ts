import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { gitExecutable } from '../../shared/git/executable.js';
import { gitLaunchMode } from '../../shared/git/launch-mode.js';
import { gitEnvironment } from '../../shared/git/environment.js';
import { runProcess, ProcessRunError } from '../../shared/process/launcher.js';
import type { ReleaseArtifact, ReleaseBuildReceipt, ReleaseOperation, ReleasePort } from '../application/release-contracts.js';
import { releaseBuildLaunch } from './release-executable.js';
import { verifyReleaseSource } from './release-source.js';
import { atomicWrite, ensureDirectory, readBoundedFile } from './journal/files.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function conflict(message: string): never { throw new DomainError('conflict', message); }
export function releaseArtifactDirectory(stateDirectory: string, operation: ReleaseOperation): string {
  const id = operation.action === 'publish' ? operation.build?.operationId : operation.operationId;
  if (!id) return conflict('Release publication requires a retained build operation.');
  return join(stateDirectory, 'release-builds', hash(operation.candidate.requestId + ':' + id), 'artifacts');
}
async function digestFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 67108864) conflict('Release artifacts must be regular files of at most 64 MiB.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length; if (bytes > 67108864) conflict('Release artifact grew beyond 64 MiB during capture.'); digest.update(chunk);
    }
    return { bytes, sha256: digest.digest('hex') };
  } finally { await file.close(); }
}
async function captureArtifact(source: string, destination: string) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 67108864) conflict('Release artifacts must be regular files of at most 64 MiB.');
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const output = await open(destination, 'wx', 0o600).catch(async error => { await input.close(); throw error; });
  try {
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      bytes += chunk.length; if (bytes > 67108864) conflict('Release artifact grew beyond 64 MiB during capture.');
      digest.update(chunk); await output.writeFile(chunk);
    }
    await output.sync(); return { bytes, sha256: digest.digest('hex') };
  } finally { await input.close(); await output.close(); }
}
async function safeArtifact(directory: string, path: string) {
  let current = directory;
  for (const part of path.split('/')) {
    current = join(current, part); const info = await lstat(current);
    if (info.isSymbolicLink()) conflict('Release artifact paths must not contain symbolic links.');
  }
  const actual = await realpath(current), root = await realpath(directory);
  if (!actual.startsWith(root + sep)) conflict('Release artifact escaped the isolated build workspace.');
  return actual;
}
/** Each build owns a fresh detached worktree and an immutable, separate artifact package. */
export function createReleaseBuild(options: { repository: string; stateDirectory: string; remote?: string; authorize?: (mutation: boolean) => void | Promise<void> }): Pick<ReleasePort, 'inspectBuild' | 'build'> {
  const directory = (operation: ReleaseOperation) => resolve(releaseArtifactDirectory(options.stateDirectory, operation), '..');
  async function git(args: string[], signal: AbortSignal, cwd = options.repository) {
    const mode = gitLaunchMode(args), env = { ...gitEnvironment(mode === 'plain' ? 'host-local' : 'host'), GIT_NO_REPLACE_OBJECTS: '1' };
    return (await runProcess(await gitExecutable(cwd, env, mode), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.longpaths=true', '-c', 'submodule.recurse=false', '-c', 'protocol.ext.allow=never', ...args], { cwd, env, mode, observation: { kind: 'git', label: 'Release build workspace' }, timeoutMs: 120000, maxOutputBytes: 1048576, signal })).stdout.toString('utf8').trim();
  }
  async function inspectBuild(operation: ReleaseOperation, signal: AbortSignal): Promise<ReleaseBuildReceipt | null> {
    signal.throwIfAborted();
    let value: ReleaseBuildReceipt;
    try { value = JSON.parse(await readBoundedFile(join(directory(operation), 'receipt.json'), 65536)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (value.operationId !== operation.operationId || value.commit !== operation.mergeCommit || !Array.isArray(value.artifacts) || value.artifacts.length !== operation.target.build.artifacts.length + 2) conflict('The retained build receipt does not match its merged-commit operation.');
    const expectedNames = [...operation.target.build.artifacts.map(path => path.split('/').at(-1)!), 'werk-release-manifest.json', 'SHA256SUMS'];
    if (new Set(value.artifacts.map(item => item.name)).size !== expectedNames.length || value.artifacts.some(item => !expectedNames.includes(item.name))) conflict('The retained build artifact inventory changed.');
    const artifacts = releaseArtifactDirectory(options.stateDirectory, operation);
    for (const item of value.artifacts) {
      const observed = await digestFile(await safeArtifact(artifacts, item.name));
      if (item.bytes !== observed.bytes || item.sha256 !== observed.sha256) conflict('A retained release artifact changed after its successful build.');
    }
    const manifest = await readBoundedFile(join(artifacts, 'werk-release-manifest.json'), 65536);
    if (hash(manifest) !== value.manifestDigest) conflict('The release build manifest digest changed.');
    const metadata = JSON.parse(manifest);
    if (metadata.schemaVersion !== 1 || metadata.requestId !== operation.candidate.requestId || metadata.inputRevision !== operation.candidate.inputRevision || metadata.candidateCommit !== operation.candidate.candidateCommit || metadata.mergedCommit !== operation.mergeCommit || metadata.operationId !== operation.operationId || metadata.builtAt !== value.builtAt || JSON.stringify(metadata.artifacts) !== JSON.stringify(value.artifacts.filter(item => !['werk-release-manifest.json', 'SHA256SUMS'].includes(item.name)))) conflict('The release build manifest no longer matches its retained provenance.');
    return value;
  }
  return { inspectBuild,
    async build(operation: ReleaseOperation, signal: AbortSignal): Promise<ReleaseBuildReceipt> {
      if (!operation.mergeCommit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(operation.mergeCommit)) conflict('Build requires the exact merged Git commit.');
      const base = directory(operation), worktree = join(base, 'worktree'), artifacts = releaseArtifactDirectory(options.stateDirectory, operation);
      await ensureDirectory(base); await ensureDirectory(artifacts);
      await options.authorize?.(true); signal.throwIfAborted();
      try {
        await lstat(worktree); conflict('This build workspace already exists without a completed receipt. Reconcile it instead of rerunning.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // Fetching objects never checks out or stages files in the registered project clone.
      await git(['fetch', '--no-tags', '--no-write-fetch-head', '--', options.remote ?? 'origin', operation.mergeCommit], signal);
      const commit = await git(['rev-parse', '--verify', operation.mergeCommit + '^{commit}'], signal);
      if (commit !== operation.mergeCommit) conflict('The merged commit could not be resolved exactly.');
      await git(['worktree', 'add', '--detach', '--lock', worktree, commit], signal);
      await verifyReleaseSource(git, worktree, commit, signal);
      await options.authorize?.(true); signal.throwIfAborted();
      const build = operation.target.build;
      try {
        const env = { ...gitEnvironment('host-local'), GIT_NO_REPLACE_OBJECTS: '1' }, launch = await releaseBuildLaunch(build.executable, build.args, worktree, env);
        await runProcess(launch.executable, launch.args, { cwd: worktree, env, mode: 'contained', verbatimCmd: launch.verbatimCmd, observation: { kind: 'git', label: 'Merged commit release build' }, timeoutMs: build.timeoutMs, maxOutputBytes: 1048576, signal });
      } catch (error) {
        if (error instanceof ProcessRunError && ['exit', 'timeout', 'output_limit', 'spawn', 'cancelled'].includes(error.reason)) conflict('The configured merged-commit build did not complete successfully. Its isolated worktree is retained for inspection.');
        throw error;
      }
      await verifyReleaseSource(git, worktree, commit, signal, build.artifacts);
      const captured: ReleaseArtifact[] = [];
      for (const path of build.artifacts) {
        signal.throwIfAborted(); const source = await safeArtifact(worktree, path), name = path.split('/').at(-1)!;
        const item = await captureArtifact(source, join(artifacts, name));
        captured.push({ name, ...item });
      }
      if (captured.reduce((total, item) => total + item.bytes, 0) > 268435456) conflict('Release artifacts exceed the 256 MiB package limit.');
      const builtAt = new Date().toISOString();
      const manifest = JSON.stringify({ schemaVersion: 1, requestId: operation.candidate.requestId, inputRevision: operation.candidate.inputRevision, candidateCommit: operation.candidate.candidateCommit, mergedCommit: commit, operationId: operation.operationId, builtAt, artifacts: captured }, null, 2) + '\n';
      await atomicWrite(join(artifacts, 'werk-release-manifest.json'), manifest);
      captured.push({ name: 'werk-release-manifest.json', ...await digestFile(join(artifacts, 'werk-release-manifest.json')) });
      await atomicWrite(join(artifacts, 'SHA256SUMS'), captured.map(item => item.sha256 + '  ' + item.name).join('\n') + '\n');
      captured.push({ name: 'SHA256SUMS', ...await digestFile(join(artifacts, 'SHA256SUMS')) });
      const receipt: ReleaseBuildReceipt = { operationId: operation.operationId, commit, artifacts: captured, manifestDigest: hash(manifest), builtAt };
      await atomicWrite(join(base, 'receipt.json'), JSON.stringify(receipt));
      return receipt;
    },
  };
}
