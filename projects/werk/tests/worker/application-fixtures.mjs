export { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { createWorkerDefinitions, createWorkerSessions, createLocalTaskboard } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
export { previewDefinition, definitionConnection } from '../../src/worker/dist/worker/application/definitions.js';
export function WorkerDefinitions(...args) { return createWorkerDefinitions(...args); }
export function WorkerSessions(...args) { return createWorkerSessions(...args); }
export function LocalTaskboard(...args) { return createLocalTaskboard(...args); }
