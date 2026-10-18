import type { DevelopmentRuntime, DevelopmentScope } from './development.js';

/** Native provider test claims are not receipts. Run the frozen checks against the retained candidate. */
export async function verifyNativeCandidate(runtime: DevelopmentRuntime, scope: DevelopmentScope, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  // Reject out-of-scope edits before launching any project verification commands.
  await runtime.capture(signal);
  for (const check of scope.checks) {
    signal.throwIfAborted();
    await runtime.check(check.id, signal);
  }
  signal.throwIfAborted();
}
