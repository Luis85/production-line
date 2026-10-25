import { closeLocalMerges } from './workspace-local-merge.js';
import type { SerialExecutor } from '../application/serial-executor.js';
import { closeReleases } from './workspace-release.js';
import { closePublications } from './workspace-publication.js';
import { initProcesses, closeProcesses } from './workspace-processes.js';
import type { WorkspaceContext } from './workspace-context.js';
import { loadWebviewToken } from '../infrastructure/webview-token.js';
import { settleCleanup } from '../../shared/lifecycle.js';
import { timingSafeEqual } from "node:crypto";
import { DomainError } from "../../shared/errors.js";
import { ensureDirectory } from "../infrastructure/journal/files.js";


export async function init(workspace: WorkspaceContext, options: { deferNativeWork?: boolean } = {}){
  workspace.nativeWorkState = options.deferNativeWork ? 'preparing' : 'starting';
  const executor: SerialExecutor = workspace.executor;
  workspace.releaseNativeWork ??= executor.suspendNativeWork();
  await ensureDirectory(workspace.config.stateDir);
  workspace.token = await loadWebviewToken(workspace.config.stateDir, workspace.config.webviewToken);
  await workspace.settings.init();
  await workspace.deliveryApprovals.init();
  await workspace.consumption.init();
  await workspace.repositoryDiscovery.init(workspace.settings.value.repositories.items);
  await workspace.featureProjects.init();
  await workspace.repositories.configure(workspace.settings.value.repositories);
  await workspace.sessions.init();
  await initProcesses(workspace);
  await workspace.board.init();
  await workspace.taskIndex.init();
  await workspace.featureTracking.init();
  await workspace.resources.init();
  workspace.resources.start();
  if (!options.deferNativeWork) await startNativeWork(workspace);
}

/** Private state is ready before HTTP opens; native work starts only after the runner's owned setup. */
export async function startNativeWork(workspace: WorkspaceContext) {
  workspace.repositoryStop.signal.throwIfAborted();
  if (workspace.nativeWorkState === 'ready') return;
  workspace.nativeWorkState = 'starting';
  await workspace.repositories.init();
  workspace.repositoryStop.signal.throwIfAborted();
  workspace.repositories.start();
  workspace.featureProjects.start();
  workspace.nativeWorkState = 'ready';
  workspace.releaseNativeWork?.();
  workspace.releaseNativeWork = undefined;
}

export function close(workspace: WorkspaceContext, options: { deferEvidence?: boolean } = {}): Promise<void>{
  workspace.acceptingTasks = false;
  workspace.repositoryStop.abort();
  // Abort Git preparation before awaiting intake; preserve evidence until remote assignments drain.
  workspace.draining ??= settleCleanup(
    [() => closeProcesses(workspace), () => workspace.featureProjects.stopIntake(), () => workspace.featureProjects.closeShared(), () => closePublications(workspace), () => closeReleases(workspace), () => closeLocalMerges(workspace), () => workspace.providerAccounts.close(), () => workspace.providerStatuses.close(),
     () => workspace.repositories.close(), () => workspace.board.close(), () => workspace.reviews.close(), () => workspace.readyReviews.close(), () => workspace.taskRequests],
    () => workspace.sessions.close({ retainEvidence: true }),
  );
  if (options.deferEvidence) return workspace.draining;
  workspace.closing ??= settleCleanup(() => workspace.draining, () => closeEvidence(workspace));
  return workspace.closing;
}

/** Runner calls this after remote assignments have also drained their final session writes. */
export function closeEvidence(workspace: WorkspaceContext): Promise<void>{
  workspace.evidenceClosing ??= settleCleanup(
    () => workspace.featureProjects.closeFeatures(),
    () => workspace.deliveryApprovals.close(),
    () => workspace.resources.close(),
    () => workspace.featureTracking.close(),
    [() => workspace.sessions.runs.close(), () => workspace.sessions.interactions.close(), () => workspace.sessions.requests.close(), () => workspace.consumption.close()],
  );
  return workspace.evidenceClosing;
}

export function authenticate(workspace: WorkspaceContext, token: string){
  const supplied = Buffer.from(token);
  if (
    supplied.length !== 64 ||
    !timingSafeEqual(supplied, Buffer.from(workspace.token))
  )
    throw new DomainError(
      "unauthorized",
      "Worker access token is incorrect.",
    );
}
