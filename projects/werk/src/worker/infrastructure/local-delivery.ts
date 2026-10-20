import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { gateDigest } from '../application/request-gates.js';
import { approvedPathMatch } from '../application/approved-paths.js';
import { buildDeliveryReview, deliveryCheckDefinitionDigest } from '../application/delivery-review.js';
import type { DeliveryCandidate, DeliveryCheckpointInput, LocalDeliveryPort } from '../application/delivery-review-contracts.js';
import { FeatureGitIo, branchName, commitId, gitPath, ordinaryDirectory } from './features/git-io.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (message: string): never => { throw new DomainError('conflict', message); };
const sha256 = (value: string) => /^[a-f0-9]{64}$/.test(value);
/** Uses the same private Git object/worktree adapter as shared publication; exposes no remote operation. */
export function createLocalDelivery(options: { repository: string; stateDirectory: string; reviewDirectory?: string }): LocalDeliveryPort {
  if (!isAbsolute(options.repository) || !isAbsolute(options.stateDirectory) || options.reviewDirectory !== undefined && !isAbsolute(options.reviewDirectory))
    throw new DomainError('invalid_input', 'Local delivery requires absolute repository, state and review paths.');
  const io = new FeatureGitIo({ repository: options.repository, stateDirectory: options.stateDirectory, remote: 'origin' });
  const configuredReviews = resolve(options.reviewDirectory ?? join(options.stateDirectory, 'reviews'));
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = pending.catch(() => {}).then(action); pending = result; return result;
  };
  async function verify(candidate: DeliveryCandidate, signal: AbortSignal): Promise<void> {
    if (!commitId(candidate.candidateCommit) || !commitId(candidate.tree) || !commitId(candidate.baseline)) fail('Delivery Git identity is invalid.');
    const root = await io.root(signal), ref = `refs/heads/${branchName(candidate.branch)}`;
    const head = (await io.output(root.path, ['rev-parse', '--verify', ref], signal)).trim();
    const tree = (await io.output(root.path, ['rev-parse', '--verify', `${candidate.candidateCommit}^{tree}`], signal)).trim();
    const parents = (await io.output(root.path, ['rev-list', '--parents', '-n', '1', candidate.candidateCommit], signal)).trim().split(' ');
    const message = await io.output(root.path, ['log', '-1', '--format=%B', candidate.candidateCommit], signal);
    if (head !== candidate.candidateCommit || tree !== candidate.tree || parents.length !== 2 || parents[1] !== candidate.baseline ||
        !message.split('\n').includes(`Werk-Candidate: ${candidate.candidateDigest}`) || !message.split('\n').includes(`Werk-Patch: ${candidate.patchDigest}`) ||
        !message.split('\n').includes(`Werk-Subject: ${subjectDigest(candidate)}`))
      fail('The retained candidate branch, commit or verification identity changed. Reconcile it before review.');
  }
  function subjectDigest(candidate: Pick<DeliveryCandidate, 'requestId' | 'inputRevision' | 'inputHash' | 'runId' | 'baseline' | 'candidateDigest' | 'patchDigest' | 'policyDigest' | 'checkDefinitionDigest'>) {
    return gateDigest({ requestId: candidate.requestId, inputRevision: candidate.inputRevision, inputHash: candidate.inputHash, runId: candidate.runId,
      baseline: candidate.baseline, candidateDigest: candidate.candidateDigest, patchDigest: candidate.patchDigest,
      policyDigest: candidate.policyDigest, checkDefinitionDigest: candidate.checkDefinitionDigest });
  }
  async function checkpoint(input: DeliveryCheckpointInput, signal: AbortSignal): Promise<DeliveryCandidate> {
    if (!input.requestId || input.requestId.length > 200 || /[\x00-\x1f\x7f]/.test(input.requestId) || !input.runId || input.runId.length > 200 || /[\x00-\x1f\x7f]/.test(input.runId) ||
        !Number.isSafeInteger(input.inputRevision) || input.inputRevision < 1 || !sha256(input.inputHash) || !sha256(input.policyDigest) ||
        !sha256(input.candidate.digest) || !commitId(input.candidate.treeDigest ?? '') || !commitId(input.scope.baseCommit) || !input.candidate.patch.trim() || !input.candidate.changedPaths.length)
      fail('A checkpoint needs a bounded request identity, explicit baseline and a captured candidate patch.');
    const root = await io.root(signal);
    const identity = { requestId: input.requestId, inputRevision: input.inputRevision, inputHash: input.inputHash, runId: input.runId,
      baseline: input.scope.baseCommit, candidateDigest: input.candidate.digest, patchDigest: hash(input.candidate.patch),
      policyDigest: input.policyDigest, checkDefinitionDigest: deliveryCheckDefinitionDigest(input.scope) };
    const subject = subjectDigest(identity), branch = `werk/delivery/${hash(input.requestId).slice(0, 12)}/${subject.slice(0, 24)}`;
    const ref = `refs/heads/${branch}`, old = await io.git(root.path, ['rev-parse', '--verify', ref], signal, undefined, true);
    const prior = old.exitCode === 0 ? old.stdout.toString('utf8').trim() : undefined;
    const createdAt = new Date().toISOString();
    const publication = await io.worktree(root, input.scope.baseCommit, signal, async worktree => {
      await io.output(worktree, ['apply', '--check', '--index', '--whitespace=nowarn', '-'], signal, input.candidate.patch);
      await io.output(worktree, ['apply', '--index', '--whitespace=nowarn', '-'], signal, input.candidate.patch);
      const raw = (await io.output(worktree, ['diff', '--cached', '--raw', '-z', '--no-renames'], signal)).split('\0').filter(Boolean);
      const paths: string[] = [];
      if (!raw.length || raw.length % 2) fail('The candidate patch contains no inspectable source changes.');
      for (let index = 0; index < raw.length; index += 2) {
        const match = /^:(000000|100644|100755) (000000|100644|100755) [a-f0-9]+ [a-f0-9]+ ([AMD])$/.exec(raw[index]!);
        const path = gitPath(raw[index + 1]!);
        if (!match || !approvedPathMatch(input.scope.approvedPaths, path)) fail('The checkpoint contains unapproved changes or unsupported file types.');
        paths.push(path);
      }
      if (gateDigest(paths.sort()) !== gateDigest([...input.candidate.changedPaths].sort())) fail('The checkpoint diff does not match the captured candidate.');
      const tree = (await io.output(worktree, ['write-tree'], signal)).trim();
      if (tree !== input.candidate.treeDigest) fail('Git conversion changed the tested source bytes. Inspect repository filters and line endings, then verify the exact source again.');
      const message = `${input.title.replace(/[\r\n\x00-\x1f]+/g, ' ').slice(0, 160) || 'Implementation checkpoint'}\n\n` +
        `Werk-Request: ${input.requestId}\nWerk-Run: ${input.runId}\nWerk-Subject: ${subject}\nWerk-Candidate: ${input.candidate.digest}\nWerk-Patch: ${identity.patchDigest}\n`;
      const candidateCommit = prior ?? (await io.output(worktree, ['commit-tree', tree, '-p', input.scope.baseCommit], signal, message)).trim();
      return { tree, candidateCommit };
    });
    const candidate = { ...identity, ...publication, branch, createdAt };
    if (!prior) {
      const result = await io.git(root.path, ['update-ref', ref, candidate.candidateCommit, '0'.repeat(candidate.candidateCommit.length)], signal, undefined, true);
      if (result.exitCode !== 0) {
        const observed = (await io.output(root.path, ['rev-parse', '--verify', ref], signal)).trim();
        candidate.candidateCommit = observed;
      }
    }
    // Reconcile a lost acknowledgement against immutable metadata and the expected tree, never overwrite a branch.
    await verify(candidate, signal);
    const committedAt = (await io.output(root.path, ['log', '-1', '--format=%cI', candidate.candidateCommit], signal)).trim();
    return { ...candidate, createdAt: committedAt };
  }
  async function writeArtifact(path: string, content: string): Promise<void> {
    const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await readFile(path, 'utf8') !== content)
        fail('An existing review artifact changed. Retain it and resolve the conflict before packaging.');
      return;
    }
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  }
  return {
    checkpoint: (input, signal) => serialize(() => checkpoint(input, signal)),
    verify,
    package: (input, signal) => serialize(async () => {
      signal.throwIfAborted(); await verify(input.candidate, signal);
      const root = await io.root(signal);
      const reviewDirectory = input.reviewDirectory === undefined ? configuredReviews : join(root.path, gitPath(input.reviewDirectory));
      if (reviewDirectory === root.path) fail('Choose a dedicated review folder, not the repository root.');
      const reviewPath = relative(root.path, reviewDirectory).split(sep).join('/');
      if (input.scope.approvedPaths.some(path => {
        const normalized = path.replace(/\/$/, '');
        return normalized === reviewPath || normalized.startsWith(reviewPath + '/') || reviewPath.startsWith(normalized + '/');
      })) fail('The review folder overlaps approved implementation source. Choose a separate review folder.');
      const listed = (await io.output(root.path, ['worktree', 'list', '--porcelain', '-z'], signal)).split('\0');
      const taskWorktrees = listed.filter(item => item.startsWith('worktree ')).map(item => resolve(item.slice(9))).filter(path => path !== root.path);
      for (const workspace of taskWorktrees) {
        const within = relative(workspace, reviewDirectory);
        if (!within || within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within)) fail('Review notes must be outside implementation worktrees.');
      }
      const reviews = await ordinaryDirectory(reviewDirectory, true);
      const review = buildDeliveryReview(input), name = `${hash(input.candidate.requestId).slice(0, 12)}-${input.candidate.candidateCommit}`;
      const path = join(reviews, name + '.md');
      const privateEvidence = await ordinaryDirectory(join(options.stateDirectory, 'delivery-evidence'), true);
      await writeArtifact(join(privateEvidence, name + '.json'), JSON.stringify(review, null, 2) + '\n');
      const publicChecks = review.checks.map(({ stdout, stderr, command, ...receipt }) => ({ ...receipt, commandFingerprint: receipt.presetFingerprint, stdoutDigest: hash(stdout), stderrDigest: hash(stderr) }));
      await writeArtifact(join(reviews, name + '.evidence.json'), JSON.stringify({ candidate: review.candidate, criteria: review.criteria, results: review.results, checks: publicChecks, ...(review.assessments ? { assessments: review.assessments } : {}), ...(review.requestDetails ? { requestDetails: review.requestDetails } : {}), ...(review.criterionDecisions ? { criterionDecisions: review.criterionDecisions } : {}), ...(review.baseline ? { baseline: review.baseline } : {}), baselineComparison: review.baselineComparison }, null, 2) + '\n');
      signal.throwIfAborted(); await writeArtifact(path, review.markdown); await verify(input.candidate, signal);
      return { ...review, reviewNotePath: path };
    }),
  };
}
