import { assertNativeWorkReady } from './workspace-native-work.js';
import { DomainError } from '../../shared/errors.js';
import { remoteDeliverySubject, remotePublicationContent, remotePublicationView } from '../application/remote-delivery-view.js';
import { runRemotePublication } from '../application/remote-delivery-runtime.js';
import type { RemoteDeliveryPort, RemotePublicationAuthorization } from '../application/remote-delivery-contracts.js';
import type { RequestCommand } from '../application/request-gates.js';
import { createLocalDelivery } from '../infrastructure/local-delivery.js';
import { createRemoteDeliveryGit } from '../infrastructure/remote-delivery-git.js';
import { createGitHubPublication } from '../infrastructure/remote-delivery-github.js';
import { authorizeDeliveryPolicy } from './workspace-delivery-policy.js';
import type { WorkspaceContext } from './workspace-context.js';

const active = new WeakMap<WorkspaceContext, Map<string, Promise<unknown>>>();
function operations(workspace: WorkspaceContext) {
  let value = active.get(workspace);
  if (!value) { value = new Map(); active.set(workspace, value); }
  return value;
}
export async function closePublications(workspace: WorkspaceContext): Promise<void> {
  await Promise.allSettled([...operations(workspace).values()]);
}
export async function publicationView(workspace: WorkspaceContext, requestId: string) {
  const request = workspace.sessions.requests.get(requestId);
  let authorized = false, reason: string | null = null;
  try { const { repositoryId, snapshot } = remoteDeliverySubject(request); await authorizeDeliveryPolicy(workspace, repositoryId, snapshot.configurationDigest); authorized = true; }
  catch (error) { reason = error instanceof DomainError ? error.message : 'The current delivery policy approval could not be confirmed.'; }
  return remotePublicationView(request, authorized, reason, operations(workspace).has(requestId));
}
/** Composition keeps remote processes bounded and tracked; the canonical journal owns every intent. */
export async function publishRequest(workspace: WorkspaceContext, input: RequestCommand, injected?: { port: RemoteDeliveryPort; authority: RemotePublicationAuthorization }) {
  assertNativeWorkReady(workspace);
  const running = operations(workspace);
  if (running.has(input.requestId)) throw new DomainError('conflict', 'This request already has an active remote observation. Wait for its recorded result.');
  // Register before any await, including policy or candidate inspection.
  const operation = Promise.resolve().then(async () => {
    const gates = workspace.sessions.requests, before = gates.get(input.requestId);
    const { snapshot, repositoryId } = remoteDeliverySubject(before);
    const authority: RemotePublicationAuthorization = { authorize: async (id, digest, mutation) => {
      if (mutation && gates.get(input.requestId).delivery?.control) throw new DomainError('conflict', 'A stop or cancellation request prevents further remote mutations. Reconcile the saved outcome.');
      if (injected) await injected.authority.authorize(id, digest, mutation);
      else await authorizeDeliveryPolicy(workspace, id, digest);
      if (mutation && gates.get(input.requestId).delivery?.control) throw new DomainError('conflict', 'A stop or cancellation request prevents further remote mutations. Reconcile the saved outcome.');
    } };
    await authority.authorize(repositoryId, snapshot.configurationDigest);
    if (input.action !== 'reconcile_publication') await workspace.board.verifyDelivery(input.requestId, before.revision);
    const taskId = before.owner.taskId;
    if (!taskId) throw new DomainError('conflict', 'Remote delivery requires a retained repository task.');
    const task = workspace.board.executionDetail(taskId);
    if (task.requestId !== before.id || task.repositoryId !== repositoryId) throw new DomainError('conflict', 'The publication repository does not match the retained request task.');
    const result = gates.command(input);
    if (result.duplicate) return result;
    const publicationId = input.action === 'reconcile_publication' ? input.publicationOperationId : input.operationId;
    const publication = result.request.delivery?.publications?.find(item => item.operationId === publicationId);
    if (!publication) throw new DomainError('conflict', 'The remote publication intent was not retained.');
    const local = createLocalDelivery({ repository: task.repository, stateDirectory: workspace.config.stateDir });
    const authorize = (mutation: boolean) => authority.authorize(repositoryId, snapshot.configurationDigest, mutation);
    const port: RemoteDeliveryPort = injected?.port ?? { verify: local.verify,
      ...createRemoteDeliveryGit({ repository: task.repository, stateDirectory: workspace.config.stateDir, authorize }),
      ...createGitHubPublication({ cwd: task.repository, authorize }) };
    const content = publication.action === 'pull_request' ? remotePublicationContent(result.request) : { title: '', body: '' };
    const outcome = await runRemotePublication({ publication, mode: input.action === 'reconcile_publication' ? 'reconcile' : 'execute', ...content,
      port, authority, signal: AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(120000)]) });
    const request = gates.deliveryUpdate(input.requestId, { action: 'publication_result', deliveryRunId: publication.candidate.runId, operationId: publication.operationId, result: outcome });
    return { request, duplicate: false };
  });
  running.set(input.requestId, operation);
  try { return await operation; } finally { if (running.get(input.requestId) === operation) running.delete(input.requestId); }
}
