import { callTimeout } from './tool-limits.js';
import { classifyDevelopmentEvidence } from './development-verification.js';
import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import { approvedFolder, approvedPathMatch, validateApprovedPaths } from './approved-paths.js';
import { gateDigest } from './request-gates.js';
import type { ToolPolicy, ToolCommandPreset } from './tool-policy.js';
import type { ToolWorktreeIdentity } from './tool-runtime.js';
import type { CandidateLimits } from './execution-policy.js';
import { sharedFeaturePublicationIssue, sharedFeaturePublicationLimits, type SharedFeaturePublicationLimits } from './shared-feature-publication-limits.js';

/** Frozen authority for a new repository implementation. Never inferred for saved proposal tasks. */
export interface DevelopmentCheck { id: string; name: string; executable: string; args: string[]; fingerprint: string; timeoutMs?: number; }
/** `sharedPublication` is frozen for requests admitted through shared intake: the publisher's patch and changed-file bounds. */
export interface DevelopmentScope { schemaVersion: 1; mode: 'worktree'; baseCommit: string; approvedPaths: string[]; checks: DevelopmentCheck[]; sharedPublication?: SharedFeaturePublicationLimits; }
export interface DevelopmentCheckEvidence {
  presetId: string; presetFingerprint: string; candidateDigest: string;
  status: 'passed' | 'failed' | 'interrupted'; exitCode: number | null;
  stdout: string; stderr: string; startedAt: string; finishedAt: string; truncated?: boolean;
}
export interface DevelopmentEvidence { schemaVersion: 1; candidateDigest: string | null; changedPaths: string[]; checks: DevelopmentCheckEvidence[]; updatedAt: string; }
export interface DevelopmentCompletion { turnId: string; runId: string; candidateDigest: string; patchSha256: string; evidenceDigest: string; verified: boolean; }
/** An approved file and its current hash (null when absent); `changed` marks candidate changes. */
export interface DevelopmentListedFile { path: string; hash: string | null; changed?: true }
/** Shared requests only: the frozen publication bounds, the candidate's measurements and the refusal when it exceeds them. */
export interface SharedPublicationStatus extends SharedFeaturePublicationLimits { patchBytes: number; changedFileCount: number; error?: string; }
/**
 * `changedPaths` is always complete. `files` is a byte-bounded listing with hashes; changed paths beyond its budget are
 * listed without hashes, then counted, and `omittedFiles` counts unchanged files below approved folders left out.
 */
export interface DevelopmentCandidate { patch: string; digest: string; changedPaths: string[]; files?: DevelopmentListedFile[]; changedPathsWithoutHashes?: string[]; omittedChangedPaths?: number; omittedFiles?: number; sharedPublication?: SharedPublicationStatus; }
export interface DevelopmentRuntime {
  /** Validate the retained workspace and durably invalidate earlier checks before a native provider may edit. */
  prepareNative?(signal: AbortSignal): Promise<void>;
  apply(input: { path: string; content: string | null; expectedHash?: string | null }, signal: AbortSignal): Promise<unknown>;
  check(presetId: string, signal: AbortSignal): Promise<DevelopmentCheckEvidence>;
  /** `paths` requests hashes for specific approved files beyond the bounded listing. */
  capture(signal: AbortSignal, paths?: readonly string[]): Promise<DevelopmentCandidate>;
  evidence(): DevelopmentEvidence;
}
/** Execution limits frozen with an attempt's dispatch; absent values use the settings defaults. */
export type DevelopmentLimits = Partial<CandidateLimits> & { commandTimeoutMs?: number };
export interface DevelopmentFactoryOptions extends DevelopmentLimits {
  scope: DevelopmentScope; worktree: string; worktreeIdentity: ToolWorktreeIdentity; repository: string;
  initialEvidence?: DevelopmentEvidence;
  checkpoint(evidence: DevelopmentEvidence): Promise<void>;
  verifyWorkspace(signal: AbortSignal): Promise<void>;
  currentPolicy(): ToolPolicy;
}
export type DevelopmentFactory = (options: DevelopmentFactoryOptions) => DevelopmentRuntime;
export type DevelopmentScopeView = Omit<DevelopmentScope, 'checks'> & { checks: Array<Pick<DevelopmentCheck, 'id' | 'name' | 'fingerprint'>> };
export function developmentScopeView(scope: DevelopmentScope): DevelopmentScopeView {
  return { schemaVersion: 1, mode: 'worktree', baseCommit: scope.baseCommit, approvedPaths: [...scope.approvedPaths], checks: scope.checks.map(({ id, name, fingerprint }) => ({ id, name, fingerprint })), ...(scope.sharedPublication ? { sharedPublication: { ...scope.sharedPublication } } : {}) };
}
/** Names participate so edits to the operator's frozen verification plan require a new request. */
export function developmentCheckFingerprint(check: Pick<ToolCommandPreset, 'id' | 'name' | 'executable' | 'args' | 'timeoutMs'>): string {
  return gateDigest({ id: check.id, name: check.name, executable: check.executable, args: check.args, ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }) });
}
export function freezeDevelopmentScope(baseCommit: string | undefined, approvedPaths: readonly string[], policy: ToolPolicy, options: { sharedPublication?: boolean } = {}): DevelopmentScope | undefined {
  const checks = policy.builtins.commands.filter(item => item.enabled && item.verification).map(item => ({ id: item.id, name: item.name, executable: item.executable, args: [...item.args], fingerprint: developmentCheckFingerprint(item), ...(item.timeoutMs === undefined ? {} : { timeoutMs: item.timeoutMs }) })).sort((a, b) => a.id.localeCompare(b.id));
  if (!baseCommit || !policy.builtins.files || !checks.length) return;
  const scope: DevelopmentScope = { schemaVersion: 1, mode: 'worktree', baseCommit, approvedPaths: [...approvedPaths], checks, ...(options.sharedPublication ? { sharedPublication: { ...sharedFeaturePublicationLimits } } : {}) };
  validateDevelopmentState(scope);
  return scope;
}
/** Folder approvals exist only for implementation scopes; proposal requests keep exact files. */
export function assertFolderApprovals(paths: readonly string[], policy: ToolPolicy, implementation = !!policy.builtins.files && policy.builtins.commands.some(item => item.enabled && item.verification)): void {
  if (!implementation && paths.some(approvedFolder)) throw new DomainError('invalid_input', 'Folder approvals (paths ending in /) require an implementation request: an assigned Git repository, repository file access and at least one required verification check. Approve exact files for a proposal.');
}
export function assertDevelopmentPolicy(scope: DevelopmentScope, policy: ToolPolicy): void {
  const current = freezeDevelopmentScope(scope.baseCommit, scope.approvedPaths, policy);
  if (!current || gateDigest(current.checks) !== gateDigest(scope.checks))
    throw new DomainError('conflict', 'Repository file access or the required verification commands changed. Create a new request with the current verification plan; retained changes are preserved.');
}
/** A shared-intake candidate above the publication bounds is never verified, even with passing receipts (defense in depth). */
export function developmentVerified(scope: DevelopmentScope, candidate: DevelopmentCandidate, evidence: DevelopmentEvidence | undefined): boolean {
  if (scope.sharedPublication && sharedFeaturePublicationIssue(candidate.patch) !== undefined) return false;
  return !!candidate.patch.trim() && candidate.changedPaths.length > 0 && !!evidence && evidence.candidateDigest === candidate.digest &&
    gateDigest([...candidate.changedPaths].sort()) === gateDigest([...evidence.changedPaths].sort()) &&
    classifyDevelopmentEvidence(scope, evidence).verified;
}
/** Recovered/publication decisions use the immutable captured patch and latest durable receipts together. */
export function developmentCompletionValid(task: {
  implementation?: DevelopmentScope; developmentEvidence?: DevelopmentEvidence; developmentCompletion?: DevelopmentCompletion;
  patch: string | null; currentTurnId?: string; runId?: string;
}): boolean {
  const { implementation: scope, developmentEvidence: evidence, developmentCompletion: receipt } = task;
  if (!scope || !evidence || !receipt || receipt.verified !== true || !task.patch || receipt.turnId !== task.currentTurnId || receipt.runId !== task.runId) return false;
  try {
    validateDevelopmentState(scope, evidence);
    return createHash('sha256').update(task.patch).digest('hex') === receipt.patchSha256 && gateDigest(evidence) === receipt.evidenceDigest &&
      receipt.candidateDigest === evidence.candidateDigest && developmentVerified(scope, { patch: task.patch, digest: receipt.candidateDigest, changedPaths: evidence.changedPaths }, evidence);
  } catch { return false; }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validSharedPublication = (value: unknown) => object(value) && Object.keys(value).length === 2 && [value.patchMaxBytes, value.changedFilesMax].every(limit => Number.isSafeInteger(limit) && Number(limit) > 0);
/** Saved private authority and receipts are validated before any recovery or tool construction. */
export function validateDevelopmentState(scope: unknown, evidence?: unknown): asserts scope is DevelopmentScope {
  const invalid = () => new DomainError('conflict', 'Saved implementation authority or verification evidence is invalid. Retained files require inspection.');
  if (!object(scope) || scope.schemaVersion !== 1 || scope.mode !== 'worktree' || typeof scope.baseCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(scope.baseCommit) || !Array.isArray(scope.checks) || !scope.checks.length || scope.checks.length > 32) throw invalid();
  try { validateApprovedPaths(scope.approvedPaths, 'Approved paths', { folders: true }); for (const check of scope.checks) if (object(check)) callTimeout(check.timeoutMs, 'Required check'); } catch { throw invalid(); }
  if (scope.sharedPublication !== undefined && !validSharedPublication(scope.sharedPublication)) throw invalid();
  if (scope.checks.some(check => !object(check) || typeof check.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(check.id) || typeof check.name !== 'string' || !check.name.trim() || check.name.length > 120 || typeof check.executable !== 'string' || !check.executable.trim() || check.executable.length > 4096 || !Array.isArray(check.args) || check.args.length > 64 || check.args.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0')) || !hash(check.fingerprint) || developmentCheckFingerprint(check as unknown as DevelopmentCheck) !== check.fingerprint) || new Set(scope.checks.map(check => check.id)).size !== scope.checks.length) throw invalid();
  if (evidence === undefined) return;
  if (!object(evidence) || evidence.schemaVersion !== 1 || evidence.candidateDigest !== null && !hash(evidence.candidateDigest) || !Array.isArray(evidence.changedPaths) || evidence.changedPaths.some(path => typeof path !== 'string' || !approvedPathMatch(scope.approvedPaths as string[], path)) || new Set(evidence.changedPaths).size !== evidence.changedPaths.length || !date(evidence.updatedAt) || !Array.isArray(evidence.checks) || evidence.checks.length > 32) throw invalid();
  const requiredChecks = scope.checks;
  if (new Set(evidence.checks.map(check => object(check) ? check.presetId : null)).size !== evidence.checks.length) throw invalid();
  if (evidence.checks.some(check => !object(check) || !requiredChecks.some(required => required.id === check.presetId && required.fingerprint === check.presetFingerprint) || !hash(check.candidateDigest) || !['passed', 'failed', 'interrupted'].includes(check.status as string) || check.exitCode !== null && !Number.isSafeInteger(check.exitCode) || check.status === 'passed' && check.exitCode !== 0 || typeof check.stdout !== 'string' || check.stdout.length > 32768 || typeof check.stderr !== 'string' || check.stderr.length > 32768 || !date(check.startedAt) || !date(check.finishedAt) || check.truncated !== undefined && typeof check.truncated !== 'boolean')) throw invalid();
}
