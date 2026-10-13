import { createHash } from 'node:crypto';
import type { Task } from '../../shared/contracts.js';
import type { Snapshot } from '../../shared/snapshots.js';
import { validateContextReference } from './context.js';
import { ReportingError } from '../application/errors.js';

const invalid = (message: string): never => { throw new ReportingError(message, false); };

export function responseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Invalid orchestrator response');
  return value as Record<string, unknown>;
}

/** Validate fields needed for safe assignment routing and lease ownership. */
export function assignmentResponse(value: unknown): Task {
  const task = responseRecord(value);
  if (typeof task.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(task.id) ||
      typeof task.lease !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(task.lease) ||
      typeof task.project !== 'string' || typeof task.workerId !== 'string' ||
      typeof task.profile !== 'string' || !Number.isSafeInteger(task.attempt) || (task.attempt as number) < 1 ||
      typeof task.expiresAt !== 'number' || !Number.isSafeInteger(task.expiresAt) || task.status !== 'running') {
    return invalid('Invalid orchestrator assignment');
  }
  if (task.context !== undefined) validateContextReference(task.context);
  return task as unknown as Task;
}

/** An HTTP 200 alone must never authorize removal from the durable snapshot outbox. */
export function acknowledgeSnapshot(value: unknown, snapshot: Snapshot): void {
  const response = responseRecord(value);
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  if (response.id !== snapshot.id || response.sha256 !== digest) invalid('Invalid snapshot acknowledgement: identity or digest mismatch');
}

export function acknowledgeCompletion(value: unknown, task: Task): void {
  const response = responseRecord(value);
  if (response.id !== task.id || response.project !== task.project || response.status !== (task.executionMode === 'cli' ? 'review' : 'simulated') ||
      response.attempt !== task.attempt || response.lease !== task.lease || response.workerId !== task.workerId ||
      response.profile !== task.profile || response.expiresAt !== null || contextIdentity(response.context) !== contextIdentity(task.context)) {
    invalid('Invalid task completion acknowledgement');
  }
}

export function acknowledgeAbandonment(value: unknown, task: Task): void {
  const response = responseRecord(value);
  if (response.id !== task.id || response.project !== task.project || !Number.isSafeInteger(response.attempt) ||
      (response.attempt as number) < task.attempt || contextIdentity(response.context) !== contextIdentity(task.context) || !['queued', 'blocked', 'running', 'simulated', 'review'].includes(String(response.status))) {
    invalid('Invalid task abandonment acknowledgement');
  }
  // An idempotent replay may report a newer assignment. For this attempt, ownership must be released.
  if (response.attempt === task.attempt && (!['queued', 'blocked'].includes(String(response.status)) ||
      response.workerId !== null || response.lease !== null || response.expiresAt !== null || response.profile !== null)) {
    invalid('Task abandonment did not release this assignment');
  }
}

/** Stable field comparison ignores JSON key order while retaining the complete server-owned pin. */
export function contextIdentity(value: unknown): string | null {
  if (value === undefined) return null;
  validateContextReference(value);
  const pin = responseRecord(value);
  return [pin.sha256, pin.commit, pin.featureId, pin.path].join('\n');
}
