                                                               
import { loadWebviewToken } from '../infrastructure/webview-token.js';
import { settleCleanup } from '../../shared/lifecycle.js';
import { timingSafeEqual } from "node:crypto";
import { DomainError } from "../../shared/errors.js";
import { ensureDirectory } from "../infrastructure/journal/files.js";


export async function init(workspace                  ){
  await ensureDirectory(workspace.config.stateDir);
  workspace.token = await loadWebviewToken(workspace.config.stateDir, workspace.config.webviewToken);
  await workspace.settings.init();
  await workspace.consumption.init();
  await workspace.repositoryDiscovery.init(workspace.settings.value.repositories.items);
  await workspace.sharedRuntime.intake.init();
  await workspace.repositories.configure(workspace.settings.value.repositories);
  await workspace.repositories.init();
  await workspace.features?.init();
  await workspace.sessions.init();
  await workspace.board.init();
  await workspace.taskIndex.init();
  await workspace.featureTracking.init();
  await workspace.resources.init();
  workspace.resources.start();
  workspace.repositories.start();
  workspace.sharedRuntime.intake.start();
}

export function close(workspace                  , options                              = {})               {
  workspace.acceptingTasks = false;
  workspace.repositoryStop.abort();
  // Abort Git preparation before awaiting intake; preserve evidence until remote assignments drain.
  workspace.draining ??= settleCleanup(
    [() => workspace.features?.stopIntake(), () => workspace.sharedRuntime.close(), () => workspace.providerAccounts.close(), () => workspace.providerStatuses.close(),
     () => workspace.repositories.close(), () => workspace.board.close(), () => workspace.reviews.close(), () => workspace.taskRequests],
    () => workspace.sessions.close({ retainEvidence: true }),
  );
  if (options.deferEvidence) return workspace.draining;
  workspace.closing ??= settleCleanup(() => workspace.draining, () => closeEvidence(workspace));
  return workspace.closing;
}

/** Runner calls this after remote assignments have also drained their final session writes. */
export function closeEvidence(workspace                  )               {
  workspace.evidenceClosing ??= settleCleanup(
    () => workspace.features?.close(),
    () => workspace.resources.close(),
    () => workspace.featureTracking.close(),
    [() => workspace.sessions.runs.close(), () => workspace.sessions.interactions.close(), () => workspace.sessions.requests.close(), () => workspace.consumption.close()],
  );
  return workspace.evidenceClosing;
}

export function authenticate(workspace                  , token        ){
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
