import { DomainError } from '../../shared/errors.js';
import { identifier, object } from '../../shared/contracts.js';
import type { DeliveryPolicySnapshot, DeliveryProjectPolicy } from './delivery-policy.js';

export interface DeliveryPolicyApproval { repositoryId: string; configurationDigest: string; approvedAt: string; }
export interface DeliveryPolicyApprovalDecision {
  action: 'approve' | 'revoke'; repositoryId: string; configurationDigest: string; at: string; revision: number;
}
export interface DeliveryPolicyApprovalState {
  schemaVersion: 1; revision: number; approvals: DeliveryPolicyApproval[]; history: DeliveryPolicyApprovalDecision[];
}
interface DeliveryPolicyApprovalCommand {
  action: 'approve' | 'revoke'; repositoryId: string; configurationDigest: string; expectedRevision: number;
}
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const key = (value: Pick<DeliveryPolicyApproval, 'repositoryId' | 'configurationDigest'>) => value.repositoryId + ':' + value.configurationDigest;
export const emptyDeliveryPolicyApprovals = (): DeliveryPolicyApprovalState => ({ schemaVersion: 1, revision: 1, approvals: [], history: [] });

/** Preserve legacy policy authority; every added capability requires a separate local operator grant. */
export function deliveryPolicyRequiresApproval(policy: DeliveryProjectPolicy): boolean {
  const original = new Set(['schemaVersion', 'version', 'defaultProfile', 'reviewDirectory', 'profiles']);
  const quality = new Set(['id', 'minimumCriteria', 'minimumMessageLength', 'maxRepairAttempts', 'verificationInputs']);
  return Object.keys(policy).some(field => !original.has(field)) ||
    policy.profiles.some(profile => Object.keys(profile).some(field => !quality.has(field)));
}
export function deliveryPolicyApproved(state: DeliveryPolicyApprovalState, repositoryId: string, snapshot: DeliveryPolicySnapshot): boolean {
  return !deliveryPolicyRequiresApproval(snapshot.configuration) ||
    state.approvals.some(approval => approval.repositoryId === repositoryId && approval.configurationDigest === snapshot.configurationDigest);
}
export function assertDeliveryPolicyApproved(state: DeliveryPolicyApprovalState, repositoryId: string, snapshot: DeliveryPolicySnapshot): void {
  if (!deliveryPolicyApproved(state, repositoryId, snapshot))
    throw new DomainError('conflict', 'This project delivery policy needs local operator approval. Review its exact configuration in Settings → Project delivery before starting work. Repository text cannot grant execution or publication authority.');
}
function validateDeliveryPolicyApprovalCommand(value: unknown): DeliveryPolicyApprovalCommand {
  const raw = object(value, 'Delivery policy approval', ['action', 'repositoryId', 'configurationDigest', 'expectedRevision']);
  if (raw.action !== 'approve' && raw.action !== 'revoke' || !digest(raw.configurationDigest) || !positive(raw.expectedRevision))
    invalid('Choose approve or revoke with the current approval revision and exact configuration digest.');
  return { action: raw.action as 'approve' | 'revoke', repositoryId: identifier(raw.repositoryId, 'Repository ID'), configurationDigest: raw.configurationDigest, expectedRevision: raw.expectedRevision };
}
export function validateDeliveryPolicyApprovals(value: unknown): DeliveryPolicyApprovalState {
  const raw = object(value, 'Saved delivery policy approvals', ['schemaVersion', 'revision', 'approvals', 'history']);
  if (raw.schemaVersion !== 1 || !positive(raw.revision) || !Array.isArray(raw.approvals) || raw.approvals.length > 512 || !Array.isArray(raw.history) || raw.history.length > 512)
    invalid('Saved delivery policy approvals are invalid. Restore the private approval record before enabling expanded delivery capabilities.');
  const revision = raw.revision;
  const approvals = raw.approvals.map(value => {
    const item = object(value, 'Policy approval', ['repositoryId', 'configurationDigest', 'approvedAt']);
    if (!digest(item.configurationDigest) || !date(item.approvedAt)) invalid('Saved policy approval identity or timestamp is invalid.');
    return { repositoryId: identifier(item.repositoryId, 'Repository ID'), configurationDigest: item.configurationDigest, approvedAt: item.approvedAt };
  });
  if (new Set(approvals.map(key)).size !== approvals.length) invalid('Saved policy approvals contain duplicate identities.');
  const history = raw.history.map(value => {
    const item = object(value, 'Policy approval history', ['action', 'repositoryId', 'configurationDigest', 'at', 'revision']);
    if (item.action !== 'approve' && item.action !== 'revoke' || !digest(item.configurationDigest) || !date(item.at) || !positive(item.revision) || item.revision > revision)
      invalid('Saved policy approval history is invalid.');
    return { action: item.action as 'approve' | 'revoke', repositoryId: identifier(item.repositoryId, 'Repository ID'), configurationDigest: item.configurationDigest, at: item.at, revision: item.revision };
  });
  if (history.some((item, index) => index > 0 && item.revision <= history[index - 1]!.revision)) invalid('Saved policy approval history is not ordered.');
  return { schemaVersion: 1, revision, approvals, history };
}
/** Pure guarded settings mutation. Only the authenticated application boundary may call it. */
export function changeDeliveryPolicyApproval(state: DeliveryPolicyApprovalState, input: unknown, now: string): DeliveryPolicyApprovalState {
  const current = validateDeliveryPolicyApprovals(state), command = validateDeliveryPolicyApprovalCommand(input);
  if (!date(now)) invalid('An approval requires the worker observation time.');
  if (command.expectedRevision !== current.revision) throw new DomainError('conflict', 'Delivery approvals changed. Reload the committed policy and approval state before trying again.');
  const existing = current.approvals.find(item => key(item) === key(command));
  if (command.action === 'approve' && existing || command.action === 'revoke' && !existing) return current;
  const revision = current.revision + 1;
  if (!Number.isSafeInteger(revision)) invalid('The approval revision limit was reached.');
  const approvals = current.approvals.filter(item => key(item) !== key(command));
  if (command.action === 'approve') approvals.push({ repositoryId: command.repositoryId, configurationDigest: command.configurationDigest, approvedAt: now });
  if (approvals.length > 512) invalid('Revoke unused policy approvals before adding another. At most 512 pinned policy versions can be authorized.');
  return { schemaVersion: 1, revision, approvals, history: [...current.history, { action: command.action, repositoryId: command.repositoryId, configurationDigest: command.configurationDigest, at: now, revision }].slice(-512) };
}
