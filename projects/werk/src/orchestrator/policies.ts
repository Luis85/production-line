import { DomainError } from '../shared/errors.js';
import type { Profile, Task } from '../shared/contracts.js';
import type { WorkerRecord } from '../shared/protocol.js';
import type { Snapshot } from '../shared/snapshots.js';

/** Machine capacity, subscription capacity and project affinity must all agree. */
export function eligibleProfile(worker: WorkerRecord, task: Task, active: readonly Task[]): Profile | undefined {
  if (task.project !== worker.project || active.length >= worker.config.maxParallel + (worker.config.queueCapacity ?? 0)) return undefined;
  return worker.profiles.find(profile => {
    const providerMatches = task.provider === 'auto' || task.provider === profile.provider;
    const occupied = active.filter(item => item.profile === profile.id).length;
    return providerMatches && profile.mode === (task.executionMode ?? 'mock') && occupied < (profile.maxParallel ?? 1) + (worker.config.queueCapacity ?? 0);
  });
}

export function assertLeaseOwnership(task: Task, workerId: string, lease: unknown, attempt: unknown, now: number): void {
  const owned = task.status === 'running' && task.workerId === workerId
    && task.lease === lease && task.attempt === attempt && (task.expiresAt ?? 0) > now;
  if (!owned) throw new DomainError('conflict', 'Lease expired, superseded or not owned by worker');
}

interface SnapshotAssignment {
  workerId: string;
  leaseId: string;
  profileId: string;
  configurationHash: string;
}

/** Historical assignment identity permits late telemetry without granting a current lease. */
export function assertSnapshotAssignment(
  snapshot: Snapshot,
  task: Task,
  assignment: SnapshotAssignment | undefined,
  worker: WorkerRecord,
): void {
  const profile = worker.profiles.find(item => item.id === snapshot.profileId);
  if (!profile || profile.provider !== snapshot.provider || profile.mode !== snapshot.mode || profile.mode !== (task.executionMode ?? 'mock')) {
    throw new DomainError('forbidden', 'Snapshot provider does not match assigned profile');
  }
  if (!assignment || assignment.workerId !== worker.id || assignment.leaseId !== snapshot.pairId
    || snapshot.workerId !== worker.id || snapshot.project !== worker.project
    || assignment.profileId !== snapshot.profileId || snapshot.provenance.configurationHash !== assignment.configurationHash) {
    throw new DomainError('forbidden', 'Snapshot does not belong to this worker/attempt/configuration');
  }
  if (snapshot.provenance.iterationId !== (task.source?.iterationId ?? null)
    || snapshot.provenance.featureId !== (task.context?.featureId ?? task.source?.featureId ?? null)
    || snapshot.provenance.sourceCommit !== (task.context?.commit ?? task.source?.commit ?? null)
    || snapshot.provenance.contextManifestHash !== (task.context?.sha256 ?? null)) {
    throw new DomainError('invalid_input', 'Snapshot source provenance does not match task');
  }
}
