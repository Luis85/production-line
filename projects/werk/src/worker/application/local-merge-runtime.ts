import { DomainError } from '../../shared/errors.js';
import type { LocalMergeOperation, LocalMergePort, LocalMergePreparation, LocalMergeResult } from './local-merge-contracts.js';

/** The owning journal retains intent and preparation before the destination checkout can change. */
export async function runLocalMerge(input: {
  operation: LocalMergeOperation; mode: 'execute' | 'reconcile'; port: LocalMergePort; signal: AbortSignal;
  authorize(mutation: boolean): void | Promise<void>; prepared(value: LocalMergePreparation): void | Promise<void>;
}): Promise<LocalMergeResult> {
  const { operation, port, signal } = input;
  let attempted = false;
  const authorize = async (mutation = false) => { signal.throwIfAborted(); await input.authorize(mutation); signal.throwIfAborted(); };
  const observe = async () => { await authorize(); return port.inspect(operation, signal); };
  const result = async (): Promise<LocalMergeResult> => {
    const current = await observe(), expected = operation.preparation;
    if (expected && current.branch === operation.mainBranch && current.head === expected.mergeCommit && current.tree === expected.tree && current.clean && current.candidateIncluded)
      return { status: 'confirmed', detail: 'The reviewed candidate is confirmed in the assigned main checkout at the retained merge commit.', receipt: { ...expected, branch: operation.mainBranch, previousHead: operation.mainHead, candidateCommit: operation.candidate.candidateCommit, mergedAt: new Date().toISOString() } };
    if (current.branch === operation.mainBranch && current.head === operation.mainHead && current.clean)
      return { status: 'not_observed', detail: 'The saved merge is not present in the main checkout. No mutation was retried; a separate explicit merge approval may retry after inspection.' };
    return { status: 'unknown', detail: 'The main checkout differs from the saved before/after states. Preserve its files and reconcile the branch, index and checkout manually before continuing.' };
  };
  try {
    if (input.mode === 'reconcile') return await result();
    const before = await observe();
    if (before.branch !== operation.mainBranch || before.head !== operation.mainHead || !before.clean)
      return { status: 'failed', detail: 'The approved main checkout branch or head changed, or its files/index are not clean. Refresh the destination and preserve local changes before approving again.' };
    await authorize(true);
    const preparation = await port.prepare(operation, signal);
    await input.prepared(preparation); operation.preparation = structuredClone(preparation);
    await authorize(true); attempted = true;
    try { await port.apply(operation, signal); } catch { /* Observe the retained exact destination after a possibly lost acknowledgement. */ }
    return await result();
  } catch (error) {
    return { status: input.mode === 'execute' && !attempted && error instanceof DomainError && error.code === 'conflict' ? 'failed' : 'unknown', detail: error instanceof DomainError && error.code === 'conflict' && !attempted ? error.message : 'The local merge outcome could not be confirmed. Preserve the checkout and reconcile this saved operation; no automatic retry is permitted.' };
  }
}
