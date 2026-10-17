import assert from 'node:assert/strict';

/** Deliberate fault injection into the real taskboard; never used by application code.
 * @param {import('../../src/worker/application/local-tasks.js').LocalTaskboard} board
 * @returns {import('../../src/worker/application/local-task-runtime-contract.js').LocalTaskRuntime}
 */
export function taskboardRuntime(board) {
  const runtime = Reflect.get(board, 'runtime');
  assert.ok(runtime && typeof runtime.change === 'function' && runtime.files && Array.isArray(runtime.tasks));
  return runtime;
}

/** Observe cached ownership for rollback tests without widening the public session API.
 * @param {import('../../src/worker/application/sessions.js').WorkerSessions} sessions
 * @returns {Map<string, import('../../src/worker/application/conversation.js').WorkerConversation>}
 */
export function sessionInstances(sessions) {
  const instances = Reflect.get(sessions, 'instances');
  assert.ok(instances instanceof Map);
  return instances;
}

/** Hold the actual conversation loader while testing provider-update admission fencing.
 * @param {import('../../src/worker/application/sessions.js').WorkerSessions} sessions
 * @param {() => Promise<void>} before
 */
export function beforeSessionLoad(sessions, before) {
  /** @type {(record: import('../../src/worker/application/sessions.js').SessionRecord) => Promise<void>} */
  const load = Reflect.get(sessions, 'load');
  assert.equal(typeof load, 'function');
  Reflect.set(sessions, 'load', async record => { await before(); return load.call(sessions, record); });
}

/** Keep real Git commands and override only the transport event under test.
 * @param {import('../../src/worker/infrastructure/features/git-repository.js').GitFeatureRepository} repository
 * @returns {import('../../src/worker/infrastructure/features/git-io.js').FeatureGitIo}
 */
export function featureGitIo(repository) {
  const io = Reflect.get(repository, 'io');
  assert.ok(io && typeof io.git === 'function' && typeof io.push === 'function');
  return io;
}

/** Access the real composition owner only for explicit lifecycle fault injection.
 * @param {import('../../src/worker/status/workspace.js').WorkerWorkspace} workspace
 * @returns {import('../../src/worker/status/workspace-context.js').WorkspaceContext}
 */
export function workspaceContext(workspace) {
  const context = Reflect.get(workspace, 'context');
  assert.ok(context && context.settings && context.sessions && context.board);
  return context;
}

/** Inspect composition authority without widening the application's public review API.
 * @param {import('../../src/worker/application/request-review.js').RequestReviewManager} manager
 * @returns {import('../../src/worker/application/request-review.js').RequestReviewOptions}
 */
export function reviewOptions(manager) {
  const options = Reflect.get(manager, 'options');
  assert.ok(options && typeof options.model === 'function' && options.gates && options.executor);
  return options;
}
