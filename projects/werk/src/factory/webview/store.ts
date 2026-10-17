
import { createState, createRuntime } from './store-state';
import type { StoreOperations } from './store-context';
import { createConnection } from './store-connection';
import { createNavigation } from './store-navigation';
import { createSelectors } from './store-selectors';
import { createRegistry } from './store-registry';
import { createRouting } from './store-routing';
import { createIntake } from './store-intake';
export * from './store-contracts';

/** Compose memory-only state and feature controllers without changing the public store API. */
export function createFactoryStore(fetcher: typeof fetch = fetch) {
  const state = createState();
  const runtime = createRuntime();
  const context = { state, runtime, fetcher };
  const actions: StoreOperations = {
    ...createConnection(context, () => actions),
    ...createNavigation(context, () => actions),
    ...createSelectors(context),
    ...createRegistry(context, () => actions),
    ...createRouting(context, () => actions),
    ...createIntake(context, () => actions),
  };
  return {
    state,
    api: actions.api,
    connect: actions.connect,
    disconnect: actions.disconnect,
    refresh: actions.refresh,
    navigate: actions.navigate,
    descendants: actions.descendants,
    factoryPath: actions.factoryPath,
    selectedLines: actions.selectedLines,
    selectedFactory: actions.selectedFactory,
    observations: actions.observations,
    activeLine: actions.activeLine,
    activeObservation: actions.activeObservation,
    managed: actions.managed,
    mayEdit: actions.mayEdit,
    openEditor: actions.openEditor,
    saveEditor: actions.saveEditor,
    confirmRemoval: actions.confirmRemoval,
    removeConfirmed: actions.removeConfirmed,
    editPolicy: actions.editPolicy,
    loadPolicy: actions.loadPolicy,
    savePolicy: actions.savePolicy,
    loadQueue: actions.loadQueue,
    submitIntake: actions.submitIntake,
    assignTarget: actions.assignTarget,
    nextStep: actions.nextStep,
  };
}

export type FactoryStore = ReturnType<typeof createFactoryStore>;
