import { DomainError } from '../../shared/errors.js';

interface NativeWorkspace { nativeWorkState?: 'preparing' | 'starting' | 'ready'; }
/** Runtime readiness is transient; it never rewrites the user's saved queue pause setting. */
export function nativeWorkStatus(workspace: NativeWorkspace) {
  const state = workspace.nativeWorkState ?? 'ready';
  const message = state === 'preparing' ? 'Preparing the command runtime. Saved requests remain queued; model and repository work will start automatically.'
    : state === 'starting' ? 'Synchronizing assigned repositories. Saved requests remain queued; model and repository work will start automatically.' : null;
  return { state, message };
}
export function assertNativeWorkReady(workspace: NativeWorkspace): void {
  const { message } = nativeWorkStatus(workspace);
  if (message) throw new DomainError('unavailable', message + ' Retry this operation shortly.');
}
