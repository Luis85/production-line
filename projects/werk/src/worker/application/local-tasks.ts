import { createLocalTaskRuntime } from './local-task-runtime.js';
import type { LocalTaskDependencies, LocalTaskRuntime } from './local-task-runtime-contract.js';
import type { LocalTaskSubmission } from './local-task-contracts.js';
import type { WorkerSettingsPort } from './workspace-ports.js';
import type { WorkerSessions } from './sessions.js';
import type { InteractionCommand } from './interactions.js';
export type { LocalTask, TaskFile, LocalTaskPreparation, LocalTaskSubmission, LocalTaskWorkspaces } from './local-task-contracts.js';

/** Public taskboard facade; one private runtime owns all admission, execution and persistence state. */
export class LocalTaskboard {
  private readonly runtime: LocalTaskRuntime;
  constructor(settings: WorkerSettingsPort, sessions: WorkerSessions, dependencies: LocalTaskDependencies) {
    this.runtime = createLocalTaskRuntime(settings, sessions, dependencies);
  }
  init() {
    return this.runtime.init();
  }
  get active() { return this.runtime.active; }
  preparation(id: string) {
    return this.runtime.preparation(id);
  }
  preparationDefinition(id: string) {
    return this.runtime.preparationDefinition(id);
  }
  preparationSelection(id: string) { return this.runtime.preparationSelection(id); }
  view() {
    return this.runtime.view();
  }
  detail(id: string) {
    return this.runtime.detail(id);
  }
  executionDetail(id: string) {
    return this.runtime.executionDetail(id);
  }
  create(input: unknown, submission?: LocalTaskSubmission) {
    return this.runtime.create(input, submission);
  }
  verifyDeliveryCheckpoint(requestId: string, expectedRevision?: number) { return this.runtime.verifyDeliveryCheckpoint(requestId, expectedRevision); }
  verifyDelivery(requestId: string, expectedRevision?: number) { return this.runtime.verifyDelivery(requestId, expectedRevision); }
  inspectStopped(requestId: string, expectedRevision?: number) { return this.runtime.inspectStopped(requestId, expectedRevision); }
  executeRequest(id: string) {
    return this.runtime.executeRequest(id);
  }
  interact(body: InteractionCommand) {
    return this.runtime.interact(body);
  }
  action(input: unknown, expectedInteractionRevision?: number) {
    return this.runtime.action(input, expectedInteractionRevision);
  }
  tick() {
    return this.runtime.tick();
  }
  close() {
    return this.runtime.close();
  }
}
