import type { WorkerRun } from '../application/run-evidence';
import type { ExecutionRecoveryCommand as RecoveryCommand } from '../application/execution-recovery';
interface ExecutionRecoveryCommand extends RecoveryCommand { action: 'confirm_execution_stopped'; }
export interface ExecutionRecoveryResult { schemaVersion: 1; run: WorkerRun; duplicate: boolean; }
interface RecoveryAccess { unlocked: boolean; fresh: boolean; acknowledged: boolean; }
/** One inspected provider attempt retains its exact operation across an uncertain response. */
export class ExecutionRecoveryController {
  pending: ExecutionRecoveryCommand | null = null;
  busy = false;
  private epoch = 0;
  private readonly send: (command: ExecutionRecoveryCommand) => Promise<ExecutionRecoveryResult>;
  private readonly operationId: () => string;
  constructor(send: (command: ExecutionRecoveryCommand) => Promise<ExecutionRecoveryResult>, operationId: () => string) { this.send = send; this.operationId = operationId; }
  reset() { this.epoch++; this.pending = null; this.busy = false; }
  async confirm(run: WorkerRun | null, note: string, access: RecoveryAccess): Promise<WorkerRun | null> {
    if (this.busy || !access.unlocked) return null;
    if (!this.pending) {
      if (!access.fresh || !access.acknowledged || !note.trim() || note.trim().length > 4000 || run?.executionRecovery?.state !== 'unknown') return null;
      this.pending = { action: 'confirm_execution_stopped', runId: run.id, expectedRevision: run.executionRecovery.revision, operationId: this.operationId(), note: note.trim() };
    }
    const command = { ...this.pending }, epoch = this.epoch;
    this.busy = true;
    try {
      const result = await this.send({ ...command });
      if (epoch !== this.epoch) return null;
      const recovery = result.run?.executionRecovery;
      if (result.schemaVersion !== 1 || result.run.id !== command.runId || recovery?.state !== 'operator_confirmed_stopped' || recovery.revision <= command.expectedRevision || recovery.confirmation?.operationId !== command.operationId || recovery.confirmation.note !== command.note)
        throw Error('The worker did not confirm this exact recovery operation. Retry the same confirmation to inspect its receipt.');
      this.pending = null;
      return result.run;
    } finally { if (epoch === this.epoch) this.busy = false; }
  }
}
