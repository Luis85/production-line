import type { Task } from '../../shared/contracts.js';
import type { Snapshot } from '../../shared/snapshots.js';
import type { AttemptDependencies } from './ports.js';
import { AttemptLease } from './lease.js';
import { assertAssignmentEvidence, assertSameEvidence } from './evidence.js';
import { reportWithRetry } from './reporting.js';

/** Runs one assigned attempt. A durable terminal snapshot is the execution replay boundary. */
export async function executeAttempt(task: Task, stop: AbortSignal, dependencies: AttemptDependencies): Promise<void> {
  const { client, journal, adapter, identity, profiles, state, saveState, timeoutMs } = dependencies;
  const now = dependencies.now ?? Date.now;
  const profile = profiles.find(candidate => candidate.id === task.profile);
  if (!profile || task.workerId !== identity.id || task.project !== identity.project || !task.lease) {
    throw Error('Invalid task assignment');
  }
  if (adapter.mode !== profile.mode || (task.executionMode ?? 'mock') !== adapter.mode) throw Error('Task, adapter and profile execution modes must match');
  const lease = new AttemptLease(task, client, state, now);
  const flush = () => journal.flush(snapshot => client.publishSnapshot(snapshot));

  try {
    await lease.start();
    let after = await journal.read(task.lease, 'after');
    const persistedBefore = await journal.read(task.lease, 'before');
    if (persistedBefore) assertAssignmentEvidence(persistedBefore, task, identity.id, profile);
    if (after) {
      assertAssignmentEvidence(after, task, identity.id, profile);
      if (!persistedBefore) throw Error('Terminal evidence requires its original before snapshot');
      assertSameEvidence(after, persistedBefore);
    }
    if (!after) {
      const before = await journal.persist(journal.capture(task, identity.id, profile, state, 'before'));
      assertAssignmentEvidence(before, task, identity.id, profile);
      state.lastSnapshot = before.id;
      await saveState();
      const signal = AbortSignal.any([stop, lease.signal, AbortSignal.timeout(timeoutMs)]);
      let outcome: Snapshot['execution']['outcome'] = 'failed';
      let error: string | null = null;
      let review: Snapshot['review'];
      try {
        if (task.context) {
          try {
            if (!client.verifyContext) throw Error('Pinned context verification is unavailable');
            await reportWithRetry(() => client.verifyContext!(task), signal);
          } catch {
            // Repository source and remote diagnostics must never become telemetry error text.
            throw Error('Pinned requirement context verification failed');
          }
        }
        signal.throwIfAborted();
        await reportWithRetry(flush, signal);
        signal.throwIfAborted();
        const result = await adapter.run(task, signal);
        signal.throwIfAborted();
        if (adapter.mode === 'mock' && result.kind !== 'simulated') throw Error('Mock adapter returned an unsupported change-set');
        if (adapter.mode === 'cli' && (result.kind !== 'change-set' || !result.review)) throw Error('Live execution requires a review artifact');
        outcome = result.kind; review = result.review;
      } catch (cause) {
        outcome = stop.aborted || lease.signal.aborted ? 'interrupted' : 'failed';
        error = signal.aborted ? 'Execution interrupted or timed out' : cause instanceof Error ? cause.message : String(cause);
      }
      const terminal = journal.capture(task, identity.id, profile, state, 'after', before, outcome, error);
      if (review && outcome === 'change-set') terminal.review = review;
      after = await journal.persist(terminal);
    }
    if (after.execution.outcome === 'change-set' && after.review) {
      if (!adapter.verifyReview) throw Error('Live adapter cannot verify persisted review evidence');
      await adapter.verifyReview(task, after.review);
    }
    state.lastSnapshot = after.id;
    // Lease ownership extends through telemetry publication and terminal acknowledgment.
    const reporting = AbortSignal.any([stop, lease.signal]);
    await reportWithRetry(flush, reporting);
    lease.signal.throwIfAborted();
    if (after.execution.outcome === 'simulated' || after.execution.outcome === 'change-set') {
      await reportWithRetry(() => { lease.signal.throwIfAborted(); return client.complete(task); }, reporting);
      if (after.execution.outcome === 'simulated') state.completedSimulations++;
      else state.completedReviews = (state.completedReviews ?? 0) + 1;
    } else {
      await reportWithRetry(() => { lease.signal.throwIfAborted(); return client.abandon(task); }, reporting);
    }
    // The server has released ownership; stop renewal before potentially slow local collection.
    await lease.close();
    await journal.checkpoint?.(task.lease);
    state.lastContact = new Date(now()).toISOString();
  } finally {
    await lease.close();
  }
}
