import { requestJson } from '../../shared/webview/http';
import type { RecordData, StoreOptions } from './store-contracts';
import { createState, createRuntime } from './store-state';
import type { StoreOperations } from './store-context';
import { createAccess } from './store-access';
import { createLists } from './store-lists';
import { createDetails } from './store-details';
import { createIntake } from './store-intake';
import { createRouting } from './store-routing';
export * from './store-contracts';

/** Compose memory-only state and feature controllers without changing the public store API. */
export function createOrchestratorStore(options: StoreOptions = {}) {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const request =
    options.request ??
    ((path, init) => requestJson<RecordData>(path, init, {
      invalidJson: status => `Keine lesbare JSON-Antwort (HTTP ${status}).`,
      failure: status => `HTTP ${status}`,
    }));
  const state = createState(options.reactive);
  const runtime = createRuntime();
  const context = { state, runtime, now, uuid, request };
  const actions: StoreOperations = {
    ...createAccess(context, () => actions),
    ...createLists(context, () => actions),
    ...createDetails(context, () => actions),
    ...createIntake(context, () => actions),
    ...createRouting(context, () => actions),
  };
  return {
    state,
    api: actions.api,
    connect: actions.connect,
    disconnect: actions.disconnect,
    clearSession: actions.clearSession,
    navigate: actions.navigate,
    refresh: actions.refresh,
    movePage: actions.movePage,
    showTask: actions.showTask,
    showTaskId: actions.showTaskId,
    closeTask: actions.closeTask,
    loadEvents: actions.loadEvents,
    showWorker: actions.showWorker,
    closeWorker: actions.closeWorker,
    submitTask: actions.submitTask,
    intakePayload: actions.intakePayload,
    checkReadiness: actions.checkReadiness,
    loadRouting: actions.loadRouting,
    saveRouting: actions.saveRouting,
    saveTaskRouting: actions.saveTaskRouting,
    inspectSnapshots: actions.inspectSnapshots,
    poll: actions.poll,
    message: actions.message,
  };
}

export type OrchestratorStore = ReturnType<typeof createOrchestratorStore>;
