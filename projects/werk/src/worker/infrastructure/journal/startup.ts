import { deliveryOwnsRun } from '../../application/execution-recovery.js';
import type { LocalTask } from '../../application/local-task-contracts.js';
import type { WorkerSettingsPort } from '../../application/workspace-ports.js';
import { restoreSessionCatalog } from '../../application/session-catalog.js';
import { isPreparedLocalTask } from '../../application/queued-task-recovery.js';
import type { WorkerRequestJournal } from './requests.js';
import type { WorkerInteractionJournal } from './interactions.js';
import type { WorkerRunJournal } from './local-runs.js';
import { localTaskStorage, sessionCatalogStorage } from './workspace-files.js';

/** Only the standard local startup coordinates preservation; standalone journals remain conservative. */
export async function initializeLocalEvidence(directory: string, settings: WorkerSettingsPort, requests: WorkerRequestJournal, interactions: WorkerInteractionJournal, runs: WorkerRunJournal) {
  try {
    await requests.open(); await interactions.open(); await runs.open();
    const saved = await localTaskStorage(directory).read();
    const value: unknown = saved === undefined ? [] : JSON.parse(saved);
    const tasks: LocalTask[] = Array.isArray(value) && value.length <= 100 ? value : [];
    const records = restoreSessionCatalog(await sessionCatalogStorage(directory).read(), settings).records;
    const requestIds = new Set<string>(), turnIds = new Set<string>(), runIds = new Set<string>();
    for (const task of tasks) {
      if (!isPreparedLocalTask(task, { requests, interactions, runs }, records)) continue;
      // Contradictory ownership cannot be made safe by choosing the first saved projection.
      if (tasks.some(other => other !== task && (other?.id === task.id || other?.sessionId === task.sessionId || other?.requestId === task.requestId || other?.currentTurnId === task.currentTurnId || other?.runId === task.runId))) continue;
      if (!requests.preparedForRecovery(task.requestId!) || !interactions.preparedForRecovery(task.sessionId, task.currentTurnId!) || !runs.queuedForRecovery(task.runId!)) continue;
      requestIds.add(task.requestId!); turnIds.add(task.currentTurnId!); runIds.add(task.runId!);
    }
    requests.recover(requestIds);
    interactions.recover(turnIds);
    await runs.recover(id => interactions.resultForRun(id), runIds, run => deliveryOwnsRun(run, requests.forSession(run.parentSessionId ?? run.sessionId)));
  } catch (error) { requests.close(); interactions.close(); runs.close(); throw error; }
}
