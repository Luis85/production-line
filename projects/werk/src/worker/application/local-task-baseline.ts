import { randomUUID } from 'node:crypto';
import { baselineCheckDigest, type DevelopmentBaselineEvidence } from './development-baseline.js';
import type { DevelopmentFactoryOptions } from './development.js';
import type { LocalTask } from './local-task-contracts.js';
import type { LocalTaskRuntime } from './local-task-runtime-contract.js';
type Host = Pick<LocalTaskRuntime, 'workspaces' | 'files' | 'development' | 'authorizeDelivery'>;
/** Baseline commands run only in a separate, owned checkout of the frozen commit. */
export async function observeTaskBaseline(host: Host, task: LocalTask, options: DevelopmentFactoryOptions, signal: AbortSignal): Promise<DevelopmentBaselineEvidence> {
  const result: DevelopmentBaselineEvidence = { schemaVersion: 1, baseline: options.scope.baseCommit, checkDefinitionDigest: baselineCheckDigest(options.scope), checks: [], observedAt: new Date().toISOString(), status: 'unavailable' };
  if (!host.workspaces || !host.development) return { ...result, reason: 'The isolated baseline workspace service is unavailable.' };
  const selector = task.repositoryId ?? task.repository, key = 'baseline-' + randomUUID();
  let workspace: Awaited<ReturnType<NonNullable<Host['workspaces']>['prepareWorktree']>> | undefined;
  let identity: Awaited<ReturnType<Host['files']['identity']>> | undefined;
  try {
    host.authorizeDelivery?.(task); signal.throwIfAborted();
    workspace = await host.workspaces.prepareWorktree(selector, key, signal, options.scope.baseCommit, options);
    if (workspace.baseCommit !== options.scope.baseCommit || workspace.repository !== task.repository || workspace.path === task.worktree || workspace.path === task.repository || workspace.reused) throw Error('Baseline workspace ownership did not match the frozen commit.');
    identity = await host.files.identity(workspace.path);
    const owned = workspace, original = identity;
    const verify = async (bounded: AbortSignal) => {
      host.authorizeDelivery?.(task);
      const actual = await host.files.identity(owned.path);
      if (actual.dev !== original.dev || actual.ino !== original.ino || actual.birthtimeMs !== original.birthtimeMs) throw Error('Baseline workspace identity changed.');
      const retained = await (host.workspaces!.verifyWorktree ?? host.workspaces!.prepareWorktree).call(host.workspaces, selector, key, bounded, options.scope.baseCommit, options);
      if (!retained.reused || retained.path !== owned.path || retained.repository !== owned.repository || retained.baseCommit !== owned.baseCommit) throw Error('Baseline workspace ownership changed.');
      bounded.throwIfAborted(); host.authorizeDelivery?.(task);
    };
    const runtime = host.development({ ...options, worktree: owned.path, worktreeIdentity: original, initialEvidence: undefined, verifyWorkspace: verify, checkpoint: async () => {} });
    const captured = await runtime.capture(signal);
    if (captured.changedPaths.length) throw Error('Baseline checkout contains source changes before verification.');
    result.sourceDigest = captured.digest;
    for (const check of options.scope.checks) {
      signal.throwIfAborted();
      result.checks.push(await runtime.check(check.id, signal));
      const after = await runtime.capture(signal);
      if (after.digest !== result.sourceDigest || after.changedPaths.length) throw Error('A baseline check changed committed source. Retained observations cannot establish an unchanged baseline.');
    }
    result.status = result.checks.some(check => check.status === 'interrupted' || check.exitCode === null) ? 'unavailable' : 'observed';
    if (result.status === 'unavailable') result.reason = 'One or more baseline checks did not return a known result.';
  } catch (error) {
    result.reason = signal.aborted ? 'Baseline observation was interrupted before every check settled.' : error instanceof Error ? error.message.slice(0, 2000) : 'Baseline checks were unavailable.';
  } finally {
    result.observedAt = new Date().toISOString();
    if (workspace && identity) {
      result.retainedWorktree = workspace.path;
      try {
        const actual = await host.files.identity(workspace.path);
        if (actual.dev === identity.dev && actual.ino === identity.ino && actual.birthtimeMs === identity.birthtimeMs && host.workspaces.removeWorktree) {
          const removed = await host.workspaces.removeWorktree(selector, key, AbortSignal.timeout(30000), { path: workspace.path, baseCommit: options.scope.baseCommit, discardChanges: false });
          if (removed.outcome === 'removed') delete result.retainedWorktree;
        }
      } catch { /* Uncertain or dirty baseline workspaces remain inspectable, never force-cleaned. */ }
    }
  }
  return result;
}
