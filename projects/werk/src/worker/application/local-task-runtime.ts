import { inspectStopped, verifyDelivery } from './delivery-task-review.js';
import { SerializedOperations } from '../../shared/serialized-operations.js';
import type { WorkerSettingsPort } from './workspace-ports.js';
import type { WorkerSessions } from './sessions.js';
import type { LocalTaskDependencies, LocalTaskRuntime } from './local-task-runtime-contract.js';
import * as group0 from './local-task-recovery.js';
import * as group1 from './local-task-preparation.js';
import * as group2 from './local-task-worktree.js';
import * as group3 from './local-task-state.js';
import * as group4 from './local-task-admission.js';
import * as group5 from './local-task-create.js';
import * as group6 from './local-task-continuation.js';
import * as group7 from './local-task-actions.js';
import * as group8 from './local-task-execution.js';

/** Compose focused lifecycle operations over one mutable owner. No helper copies admission state. */
export function createLocalTaskRuntime(settings: WorkerSettingsPort, sessions: WorkerSessions, dependencies: LocalTaskDependencies): LocalTaskRuntime {
  const runtime: LocalTaskRuntime = {
    ...dependencies, settings, sessions,
    tasks: [], writing: new SerializedOperations(), admitting: new SerializedOperations(),
    admissionReserved: false, preparations: [], preparationOwners: new Map(),
    continuationReservations: 0, continuations: new Set(), workspaceController: new AbortController(),
    running: new Map(), closed: false, persistenceError: false, evidencePersistenceError: false,
    init: () => group0.init(runtime),
    recoverTask: (task) => group0.recoverTask(runtime, task),
    reserveRun: (task) => group1.reserveRun(runtime, task),
    gateInput: (task) => group1.gateInput(runtime, task),
    ensureRequest: (task) => group1.ensureRequest(runtime, task),
    outputFacts: (valid, task) => group1.outputFacts(valid, task),
    context: (task) => group1.taskContext(task),
    originalPrompt: (task) => group1.originalPrompt(task),
    preparedRequest: (task, turn, model) => group1.preparedRequest(runtime, task, turn, model),
    restoredDevelopment: (task, turn) => group1.restoredDevelopment(task, turn),
    assertAcceptedSnapshots: (task) => group1.assertAcceptedSnapshots(task),
    prepareTurn: (task, turn, admission) => group1.prepareTurn(runtime, task, turn, admission),
    validatedPatch: (task, reply) => group1.validatedPatch(task, reply),
    completionMessage: (task, summary, reply) => group1.completionMessage(task, summary, reply),
    writePatch: (task, patch) => group1.writePatch(runtime, task, patch),
    input: (task) => group1.input(task),
    developmentRuntime: (task, limits, persistEvidence) => group2.developmentRuntime(runtime, task, limits, persistEvidence),
    assertToolWorkspace: (task, signal, verifyOnly, inspection) => group2.assertToolWorkspace(runtime, task, signal, verifyOnly, inspection),
    removeTaskWorktree: (task, requested, discardChanges) => group2.removeTaskWorktree(runtime, task, requested, discardChanges),
    get active() { return group3.active(runtime); },
    get admissionOccupancy() { return group3.admissionOccupancy(runtime); },
    preparation: (id) => group3.preparation(runtime, id),
    preparationDefinition: (id) => group3.preparationDefinition(runtime, id),
    preparationSelection: (id) => { const selection = runtime.preparationOwners.get(id)?.selection; return selection && structuredClone(selection); },
    view: () => group3.view(runtime),
    get waitingPreparations() { return group3.waitingPreparations(runtime); },
    detail: (id) => group3.detail(runtime, id),
    executionDetail: (id) => group3.executionDetail(runtime, id),
    persist: (tasks) => group3.persist(runtime, tasks),
    change: (operation) => group3.change(runtime, operation),
    trackContinuation: (operation) => group3.trackContinuation(runtime, operation),
    close: () => group3.close(runtime),
    create: (input, submission) => group4.create(runtime, input, submission),
    forgetPreparation: (preparation) => group4.forgetPreparation(runtime, preparation),
    createInBackground: (input, submission) => group4.createInBackground(runtime, input, submission),
    assertAdmissionCapacity: (tasks, reserved) => group4.assertAdmissionCapacity(runtime, tasks, reserved),
    admissionInput: (input, submission, frozenDefinition, frozenSelection) => group4.admissionInput(runtime, input, submission, frozenDefinition, frozenSelection),
    createTask: (input, submission, options) => group5.createTask(runtime, input, submission, options),
    executeRequest: (id) => group6.executeRequest(runtime, id),
    verifyDelivery: (id, expectedRevision) => verifyDelivery(runtime, id, expectedRevision),
    inspectStopped: (id, expectedRevision) => inspectStopped(runtime, id, expectedRevision),
    executeOwnedRequest: (id) => group6.executeOwnedRequest(runtime, id),
    interact: (body) => group6.interact(runtime, body),
    continueTask: (body) => group6.continueTask(runtime, body),
    action: (input, expectedInteractionRevision) => group7.action(runtime, input, expectedInteractionRevision),
    tick: () => group8.tick(runtime),
    execute: (id, controller) => {
      const task = runtime.tasks.find(item => item.id === id);
      return task && runtime.observations
        ? runtime.observations.run({ featureRequestKey: task.feature?.key ?? null, sessionId: task.sessionId, taskId: task.id, runId: task.runId ?? null }, () => group8.execute(runtime, id, controller))
        : group8.execute(runtime, id, controller);
    },
  };
  return runtime;
}
