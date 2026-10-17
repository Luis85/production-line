import type { LocalTaskboardView } from '../application/workspace-view';

export type FeatureRequestPreparation = NonNullable<LocalTaskboardView['preparations']>[number];
interface PreparationPorts {
  active(): boolean;
  read(): Promise<LocalTaskboardView>;
  progress(preparation: FeatureRequestPreparation): void;
  now?: () => number;
  pause?: () => Promise<void>;
}
const unconfirmed = 'Preparation could not be confirmed. Retry the same request to recover it.';

/** Observe one submission without resending it or claiming preparation is durable acceptance. */
export async function waitForPreparedSession(id: string, initial: FeatureRequestPreparation, ports: PreparationPorts): Promise<string | undefined> {
  const now = ports.now ?? Date.now;
  const pause = ports.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 500)));
  const deadline = now() + 11 * 60_000;
  let preparation = initial;
  while (ports.active()) {
    if (preparation?.id !== id || !['preparing', 'failed'].includes(preparation.state) || !['waiting', 'worktree', 'admission'].includes(preparation.phase)) throw Error(unconfirmed);
    if (preparation.state === 'failed') throw Error((preparation.error || 'The worker could not prepare this request.') + ' Your instructions are kept. Retry the same request after resolving the problem.');
    ports.progress({ ...preparation });
    if (now() >= deadline) throw Error('Request preparation is taking longer than expected. Your instructions are kept. Retry the same request to recover its result.');
    await pause();
    if (!ports.active()) return;
    if (now() >= deadline) throw Error('Request preparation is taking longer than expected. Your instructions are kept. Retry the same request to recover its result.');
    const board = await ports.read();
    if (!ports.active()) return;
    const pending = board.preparations?.find(item => item.id === id);
    if (pending) { preparation = pending; continue; }
    const task = board.tasks?.find(item => item.id === id);
    if (task && typeof task.sessionId === 'string' && task.sessionId) return task.sessionId;
    throw Error(unconfirmed);
  }
}
