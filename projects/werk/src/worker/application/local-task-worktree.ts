
import { assertDevelopmentPolicy, validateDevelopmentState, type DevelopmentLimits, type DevelopmentRuntime } from './development.js';

import type { ToolWorktreeIdentity } from './tool-runtime.js';

import { DomainError } from "../../shared/errors.js";

import { BACKGROUND_ADMISSION_TIMEOUT_MS, type LocalTask } from './local-task-contracts.js';
import type { LocalTaskRuntime } from './local-task-runtime-contract.js';

export function developmentRuntime(host: Pick<LocalTaskRuntime, "settings" | "development" | "assertToolWorkspace" | "change">, task: LocalTask, limits: DevelopmentLimits = {}, persistEvidence = true): DevelopmentRuntime | undefined {
    if (!task.implementation) return;
    validateDevelopmentState(task.implementation, task.developmentEvidence);
    assertDevelopmentPolicy(task.implementation, host.settings.toolPolicy());
    if (!host.development || !task.worktree || !task.worktreeIdentity) throw new DomainError('unavailable', 'Implementation tools are unavailable; the accepted worktree is retained.');
    return host.development({ scope: structuredClone(task.implementation), worktree: task.worktree, worktreeIdentity: task.worktreeIdentity, repository: task.repository,
      initialEvidence: task.developmentEvidence, commandTimeoutMs: limits.commandTimeoutMs,
      candidateSourceMaxBytes: limits.candidateSourceMaxBytes, candidateSourceMaxFiles: limits.candidateSourceMaxFiles, candidateFileMaxBytes: limits.candidateFileMaxBytes,
      candidateApprovedFileMaxBytes: limits.candidateApprovedFileMaxBytes, candidateApprovedTotalMaxBytes: limits.candidateApprovedTotalMaxBytes, candidateReviewPatchMaxBytes: limits.candidateReviewPatchMaxBytes,
      verifyWorkspace: signal => host.assertToolWorkspace(task, signal, !persistEvidence, limits), currentPolicy: () => host.settings.toolPolicy(),
      checkpoint: async evidence => {
        if (!persistEvidence) return;
        validateDevelopmentState(task.implementation, evidence);
        await host.change(tasks => { const current = tasks.find(item => item.id === task.id);
          if (!current || current.currentTurnId !== task.currentTurnId || current.status !== 'running') throw new DomainError('conflict', 'This implementation attempt no longer owns its worktree.');
          current.developmentEvidence = structuredClone(evidence);
          delete current.developmentCompletion;
        });
        task.developmentEvidence = structuredClone(evidence);
        delete task.developmentCompletion;
      },
    });
  }

export async function assertToolWorkspace(host: Pick<LocalTaskRuntime, "settings" | "workspaces" | "files">, task: LocalTask, signal: AbortSignal, verifyOnly = false, inspection: DevelopmentLimits = host.settings.value.execution) {
    const policy = host.settings.toolPolicy();
    const granted = policy.services?.enabled && policy.services.presets.some(item => item.enabled) || policy.builtins.files || policy.builtins.commands.some(item => item.enabled) || policy.builtins.cliTools.some(item => item.enabled) || policy.builtins.webOrigins.length || policy.mcp.some(item => item.enabled && item.allowedTools.length);
    if (!granted || !task.worktree) return;
    const fail = () => new DomainError('conflict', 'The retained task worktree could not be verified. Create a new task before using tools; accepted file snapshots remain saved.');
    if (!task.worktreeIdentity || !task.baseCommit || !host.workspaces) throw fail();
    const verifyIdentity = async () => {
      let actual; try { actual = await host.files.identity(task.worktree!); } catch { throw fail(); }
      if (actual.dev !== task.worktreeIdentity!.dev || actual.ino !== task.worktreeIdentity!.ino || actual.birthtimeMs !== task.worktreeIdentity!.birthtimeMs) throw fail();
    };
    // Check before the preparation port: a missing directory must never be recreated here.
    await verifyIdentity();
    const selector = task.repositoryId && host.settings.value.repositories.items.some(item => item.id === task.repositoryId) ? task.repositoryId : task.repository;
    // Admission already synchronized the repository; verify its pins without fetching twice.
    const prepare = verifyOnly && host.workspaces.verifyWorktree ? host.workspaces.verifyWorktree.bind(host.workspaces) : host.workspaces.prepareWorktree.bind(host.workspaces);
    const retained = await prepare(selector, task.worktreeKey ?? task.id, signal, task.baseCommit, inspection);
    if (!retained.reused || retained.path !== task.worktree || retained.repository !== task.repository || retained.baseCommit !== task.baseCommit || retained.repositoryId !== task.repositoryId) throw fail();
    await verifyIdentity();
  }

export async function removeTaskWorktree(host: Pick<LocalTaskRuntime, "workspaces" | "files" | "settings" | "workspaceController">, task: LocalTask, requested: boolean | undefined, discardChanges: boolean) {
    if (requested === false || !task.worktree || !task.baseCommit)
      return { outcome: "not_applicable" as const };
    const keep = (reason: string) => {
      if (requested) throw new DomainError("conflict", `${reason} The task was not deleted; delete it with removeWorktree false to keep the worktree.`);
      return { outcome: "kept" as const, reason };
    };
    if (!host.workspaces?.removeWorktree) return keep("This worker cannot remove task worktrees.");
    // The identity pin is checked before Git sees the path: a replaced directory or
    // link at the recorded location is never removed. A missing directory is only
    // unregistered from Git.
    let identity: ToolWorktreeIdentity | undefined;
    try { identity = await host.files.identity(task.worktree); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return keep("The task worktree changed after it was created; review it manually."); }
    if (identity && (!task.worktreeIdentity || identity.dev !== task.worktreeIdentity.dev || identity.ino !== task.worktreeIdentity.ino || identity.birthtimeMs !== task.worktreeIdentity.birthtimeMs))
      return keep("The task worktree changed after it was created; review it manually.");
    const selector = task.repositoryId && host.settings.value.repositories.items.some((item) => item.id === task.repositoryId) ? task.repositoryId : task.repository;
    let result;
    try {
      result = await host.workspaces.removeWorktree(selector, task.worktreeKey ?? task.id, AbortSignal.any([host.workspaceController.signal, AbortSignal.timeout(BACKGROUND_ADMISSION_TIMEOUT_MS)]), { path: task.worktree, baseCommit: task.baseCommit, discardChanges });
    } catch (error) {
      return keep(error instanceof DomainError ? error.message : "The task worktree could not be removed.");
    }
    return result.outcome === "removed" ? { outcome: "removed" as const } : keep(result.reason ?? "The task worktree was kept.");
  }
