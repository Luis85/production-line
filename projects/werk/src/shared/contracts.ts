/** Compatibility facade for domain types and validation. No transport dependencies. */
export type { Provider, TaskInput, Task, Profile, WorkerPolicy, Adapter } from './domain.js';
export { workerPolicy, repositoryScope, text, identifier, object, gitCommit, sha256, taskInput, profiles } from './validation.js';
