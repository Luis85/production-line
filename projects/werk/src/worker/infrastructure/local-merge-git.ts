import { DomainError } from '../../shared/errors.js';
import { FeatureGitIo, branchName, commitId, gitPath } from './features/git-io.js';
import { assertLocalMergeTransforms } from './local-merge-transforms.js';
import { localMergeTransaction } from './local-merge-transaction.js';
import type { LocalMergeOperation, LocalMergePort, LocalMergePreparation } from '../application/local-merge-contracts.js';
function conflict(message: string): never { throw new DomainError('conflict', message); }

/** Only explicit operator approval may update the assigned checkout; temporary merge objects never alter it. */
export function createLocalMergeGit(options: { repository: string; stateDirectory: string; branch?: string; metadataPaths?: string[]; protectedPaths?: string[]; authorize?: (mutation: boolean) => void | Promise<void> }, io = new FeatureGitIo({ ...options, remote: 'origin', literalObjects: true })): LocalMergePort & { destination(signal: AbortSignal): Promise<{ checkoutPath: string; branch: string; head: string; clean: boolean }> } {
  async function root(operation: LocalMergeOperation | undefined, signal: AbortSignal) {
    const value = await io.root(signal);
    if (operation && operation.checkoutPath !== value.path) conflict('The assigned main checkout path changed after merge approval. Restore its identity before reconciliation.');
    if (operation && options.branch && options.branch !== operation.mainBranch) conflict('The assigned main branch changed after merge approval.');
    return value;
  }
  async function destination(signal: AbortSignal, commits: string[] = []) {
    const value = await root(undefined, signal);
    await assertLocalMergeTransforms(io, value.path, commits, signal);
    const branch = (await io.output(value.path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).trim(); branchName(branch);
    if (options.branch && branch !== options.branch) conflict('The assigned main checkout is on another branch. Switch it explicitly after preserving local changes.');
    const head = (await io.output(value.path, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
    if (!commitId(head)) conflict('The main checkout does not have a full committed head.');
    const index = (await io.output(value.path, ['ls-files', '-v', '-z'], signal)).split('\0').filter(Boolean);
    if (index.some(entry => entry[0] !== 'H')) conflict('Main checkout merge does not support sparse, skipped or assume-unchanged index entries. Restore an ordinary fully visible index before approval.');
    const clean = !(await io.output(value.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)).length;
    return { checkoutPath: value.path, branch, head, clean };
  }
  async function inspect(operation: LocalMergeOperation, signal: AbortSignal) {
    const value = await root(operation, signal), observed = await destination(signal, [operation.candidate.candidateCommit, ...(operation.preparation ? [operation.preparation.mergeCommit] : [])]);
    const tree = (await io.output(value.path, ['rev-parse', '--verify', 'HEAD^{tree}'], signal)).trim();
    const included = await io.git(value.path, ['merge-base', '--is-ancestor', operation.candidate.candidateCommit, observed.head], signal, undefined, true);
    if (![0, 1].includes(included.exitCode ?? -1)) conflict('The saved candidate ancestry could not be inspected.');
    return { branch: observed.branch, head: observed.head, tree, clean: observed.clean, candidateIncluded: included.exitCode === 0 };
  }
  async function checkedPreparation(operation: LocalMergeOperation, prepared: LocalMergePreparation, signal: AbortSignal): Promise<LocalMergePreparation> {
    const value = await root(operation, signal);
    const changed = (await io.output(value.path, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', operation.candidate.candidateCommit, prepared.mergeCommit], signal)).split('\0').filter(Boolean);
    if (!changed.length) return prepared;
    if (changed.length > 512) conflict('The prepared merge exceeds the bounded workflow metadata exception. Rework and verify the new main baseline.');
    const protectedPaths = (options.protectedPaths ?? []).map(path => gitPath(path).toLowerCase());
    const allowed = changed.every(path => {
      gitPath(path);
      if (protectedPaths.includes(path.toLowerCase())) return false;
      return (options.metadataPaths ?? []).some(entry => {
        const directory = entry.endsWith('/') ? gitPath(entry.slice(0, -1)) + '/' : null;
        if (!directory) return path === entry;
        if (!path.startsWith(directory)) return false;
        const relative = path.slice(directory.length);
        return /^[^/_][^/]*\.md$/.test(relative) || /^_operations\/[a-f0-9]{64}\.json$/.test(relative);
      });
    });
    if (!allowed) conflict('Main contains source or configuration changes outside the verified candidate and retained workflow metadata. Rework against this main head and verify the combined source before approving merge.');
    const entries = (await io.output(value.path, ['ls-tree', '-r', '-z', prepared.mergeCommit], signal)).split('\0').filter(Boolean);
    const regular = new Set(entries.filter(entry => /^100644 blob [a-f0-9]+\t/.test(entry)).map(entry => entry.slice(entry.indexOf('\t') + 1)));
    const names = new Set(entries.map(entry => entry.slice(entry.indexOf('\t') + 1)));
    if (changed.some(path => names.has(path) && !regular.has(path))) conflict('Workflow metadata merge exceptions require regular non-executable files.');
    return { ...prepared, metadataPaths: changed };
  }
  async function prepare(operation: LocalMergeOperation, signal: AbortSignal): Promise<LocalMergePreparation> {
    const value = await root(operation, signal), candidate = operation.candidate;
    await assertLocalMergeTransforms(io, value.path, [operation.mainHead, candidate.candidateCommit], signal);
    for (const id of [operation.mainHead, candidate.candidateCommit, candidate.tree, candidate.baseline]) if (!commitId(id)) conflict('Main checkout merge requires exact retained Git identities.');
    branchName(operation.mainBranch);
    const tree = (await io.output(value.path, ['rev-parse', '--verify', `${candidate.candidateCommit}^{tree}`], signal)).trim();
    if (tree !== candidate.tree) conflict('The candidate Git tree changed from its verified receipt.');
    if (operation.preparation) return checkedPreparation(operation, structuredClone(operation.preparation), signal);
    const ancestor = async (left: string, right: string) => {
      const result = await io.git(value.path, ['merge-base', '--is-ancestor', left, right], signal, undefined, true);
      if (![0, 1].includes(result.exitCode ?? -1)) conflict('The main/candidate ancestry could not be established.');
      return result.exitCode === 0;
    };
    if (await ancestor(operation.mainHead, candidate.candidateCommit)) return checkedPreparation(operation, { mergeCommit: candidate.candidateCommit, tree }, signal);
    if (await ancestor(candidate.candidateCommit, operation.mainHead)) return checkedPreparation(operation, { mergeCommit: operation.mainHead, tree: (await io.output(value.path, ['rev-parse', `${operation.mainHead}^{tree}`], signal)).trim() }, signal);
    await options.authorize?.(true);
    const merged = await io.git(value.path, ['merge-tree', '--write-tree', '--no-messages', operation.mainHead, candidate.candidateCommit], signal, undefined, true);
    const mergedTree = merged.stdout.toString('utf8').trim().split(/\r?\n/)[0] ?? '';
    if (merged.exitCode !== 0 || !commitId(mergedTree)) conflict('The reviewed candidate conflicts with the current main checkout. Main was preserved; rebase and verify a new candidate before approving again.');
    const message = `Merge reviewed Werk candidate\n\nWerk-Local-Merge: ${operation.operationId}\nWerk-Request: ${candidate.requestId}\nWerk-Candidate: ${candidate.candidateDigest}\n`;
    const mergeCommit = (await io.output(value.path, ['commit-tree', mergedTree, '-p', operation.mainHead, '-p', candidate.candidateCommit], signal, message)).trim();
    if (!commitId(mergeCommit)) conflict('The isolated merge commit could not be retained.');
    return checkedPreparation(operation, { mergeCommit, tree: mergedTree }, signal);
  }
  async function apply(operation: LocalMergeOperation, signal: AbortSignal) {
    const value = await root(operation, signal), prepared = operation.preparation;
    await assertLocalMergeTransforms(io, value.path, [operation.mainHead, operation.candidate.candidateCommit, ...(prepared ? [prepared.mergeCommit] : [])], signal);
    if (!prepared || !commitId(prepared.mergeCommit) || !commitId(prepared.tree)) conflict('The prepared main checkout merge was not retained.');
    await localMergeTransaction({ repository: value.path, branch: operation.mainBranch, previous: operation.mainHead, next: prepared.mergeCommit, signal }, async () => {
        const current = await inspect(operation, signal);
        if (current.branch !== operation.mainBranch || current.head !== operation.mainHead || !current.clean) conflict('The main branch, head or checkout changed while merge approval was being applied.');
        const actualTree = (await io.output(value.path, ['rev-parse', `${prepared.mergeCommit}^{tree}`], signal)).trim();
        if (actualTree !== prepared.tree) conflict('The prepared merge commit tree changed.');
        await options.authorize?.(true); signal.throwIfAborted();
        // Two-tree unpack refuses local/index/untracked collisions. No force, reset, stash or discard is used.
        await io.output(value.path, ['read-tree', '-m', '-u', operation.mainHead, prepared.mergeCommit], signal);
      });
  }
  return { destination, inspect, prepare, apply };
}
