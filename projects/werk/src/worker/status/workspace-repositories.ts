import type { CandidateInspectionLimits } from '../application/execution-policy.js';
import { stopSessionProcesses } from './workspace-processes.js';
import type { WorkspaceContext } from './workspace-context.js';
import { prepareRepositoryWorktree, RepositoryGitError, WorktreeProblem, WORKTREE_CHECKOUT_TIMEOUT_MS } from '../infrastructure/repositories.js';
import { removeRepositoryWorktree, repositoryRoot, worktreeName } from '../infrastructure/repositories-git.js';
import { object, identifier } from "../../shared/contracts.js";
import { join, isAbsolute } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { DomainError } from "../../shared/errors.js";


function worktreeFailure(error: unknown) {
  if (error instanceof WorktreeProblem) return new DomainError("conflict", error.message);
  if (error instanceof RepositoryGitError) return new DomainError(error.reason === "failed" ? "conflict" : "unavailable", error.message);
  return error;
}

export function repositoryStatus(workspace: WorkspaceContext){
  return { schemaVersion: 1, pollMs: workspace.settings.value.repositories.pollMs, items: workspace.repositories.view(), discovery: workspace.repositoryDiscovery.view() };
}

export async function repositoryCommand(workspace: WorkspaceContext, input: unknown){
  const body = object(input, "Repository command", ["action", "id", "discoveryId"]);
  if (body.action === "accept" || body.action === "decline") {
    if (body.id !== undefined) throw new DomainError("invalid_input", "Use discoveryId for the detected installation repository.");
    return chooseDiscoveredRepository(workspace, body.action, body.discoveryId);
  }
  if (body.discoveryId !== undefined) throw new DomainError("invalid_input", "Use discoveryId only when accepting or declining a detected repository.");
  if (body.action === "status" && body.id === undefined) return repositoryStatus(workspace);
  if (body.action !== "sync" || (body.id !== undefined && typeof body.id !== "string"))
    throw new DomainError("invalid_input", "Use status or sync with an optional repository id.");
  if (!workspace.acceptingTasks || workspace.repositoriesUpdating || workspace.configurationUpdating || workspace.executionProfiles?.pending())
    throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
  if (body.id !== undefined) workspace.repositories.resolve(body.id as string);
  await workspace.repositories.sync(body.id as string | undefined);
  return repositoryStatus(workspace);
}

export function assertRepositoryChangeAllowed(workspace: WorkspaceContext){
  if (!workspace.acceptingTasks || workspace.configurationUpdating || workspace.executionProfiles?.pending())
    throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
  if (workspace.repositoriesUpdating || workspace.repositoryPreparations || workspace.sessions.busy || workspace.board.active || workspace.get().activeTasks.length || workspace.get().queuedTasks?.length)
    throw new DomainError("conflict", "Finish or cancel queued and active tasks before changing repository assignments.");
}

async function chooseDiscoveredRepository(workspace: WorkspaceContext, action: "accept" | "decline", id: unknown){
  if (action === "accept") assertRepositoryChangeAllowed(workspace);
  else if (!workspace.acceptingTasks || workspace.repositoriesUpdating || workspace.configurationUpdating)
    throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
  workspace.repositoriesUpdating = true;
  try {
    await workspace.repositoryDiscovery.verify(id);
    await workspace.repositoryDiscovery.assignmentsChanged(workspace.settings.value.repositories.items);
    const candidate = workspace.repositoryDiscovery.view();
    if (!candidate || candidate.id !== id) throw new DomainError("conflict", "The installation repository changed. Refresh and review it before choosing.");
    if (action === "decline") {
      if (candidate.repositoryId && candidate.decision === "accepted") throw new DomainError("conflict", "This repository is assigned already. Remove its assignment before declining it.");
      await workspace.repositoryDiscovery.record("declined");
    } else {
      if (!candidate.repositoryId) {
        const configuration = workspace.settings.value.repositories;
        await workspace.settings.update({ repositories: { ...configuration, items: [...configuration.items, workspace.repositoryDiscovery.assignment(configuration.items)] } });
      }
      const assignment = workspace.settings.value.repositories.items.find(item => item.path === candidate.path || item.id === candidate.repositoryId);
      await workspace.repositoryDiscovery.record("accepted", assignment?.id);
      await workspace.repositoryDiscovery.assignmentsChanged(workspace.settings.value.repositories.items);
      await workspace.repositories.configure(workspace.settings.value.repositories);
    }
    return repositoryStatus(workspace);
  } finally { workspace.repositoriesUpdating = false; }
}

export async function prepareTaskWorkspace(workspace: WorkspaceContext, selector: string, key: string, signal: AbortSignal, commit?: string, verify = false, inspection: Partial<CandidateInspectionLimits> = workspace.settings.value.execution){
  if (!workspace.acceptingTasks || workspace.repositoriesUpdating || workspace.configurationUpdating || workspace.executionProfiles?.pending())
    throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
  signal = AbortSignal.any([signal, workspace.repositoryStop.signal]);
  workspace.repositoryPreparations++;
  try {
    if (workspace.settings.value.repositories.items.length)
      return await (verify ? workspace.repositories.verifyWorktree(selector, key, signal, commit, inspection) : workspace.repositories.prepareWorktree(selector, key, signal, commit, inspection));
    // Legacy approved-file tasks may still use an ordinary, non-Git project folder.
    if (!isAbsolute(selector)) throw new DomainError("invalid_input", "Choose an assigned repository or an absolute project folder.");
    const repository = await realpath(selector);
    await workspace.repositoryDiscovery.assertAllowed(repository);
    const metadata = await lstat(join(repository, ".git")).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return metadata ? await prepareRepositoryWorktree(repository, key, signal, commit, { ...inspection, checkoutTimeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS, ...(verify ? { reuseOnly: true } : {}) }) : { repository, path: repository };
  } catch (error) { throw worktreeFailure(error); }
  finally { workspace.repositoryPreparations--; }
}

export async function removeTaskWorkspace(workspace: WorkspaceContext, selector: string, key: string, signal: AbortSignal, expected: { path: string; baseCommit: string; discardChanges: boolean }){
  if (!workspace.acceptingTasks || workspace.repositoriesUpdating || workspace.configurationUpdating)
    throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
  signal = AbortSignal.any([signal, workspace.repositoryStop.signal]);
  const task = workspace.board.view().tasks.find(item => item.worktreeKey === key && item.worktree === expected.path);
  if (task) await stopSessionProcesses(workspace, task.sessionId);
  const options = { expect: { taskKey: key, path: expected.path, baseCommit: expected.baseCommit }, discardChanges: expected.discardChanges, checkoutTimeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS };
  workspace.repositoryPreparations++;
  try {
    if (workspace.settings.value.repositories.items.length)
      return await workspace.repositories.removeWorktree(selector, { taskKey: key }, signal, options);
    const root = await repositoryRoot(selector, signal);
    await workspace.repositoryDiscovery.assertAllowed(root.path);
    return await removeRepositoryWorktree(root, worktreeName("local", key), signal, 30000, options);
  } catch (error) { throw worktreeFailure(error); }
  finally { workspace.repositoryPreparations--; }
}

/** Owned task worktrees of assigned repositories, with the file task that still uses each. */
export async function worktrees(workspace: WorkspaceContext){
  const repositories = await workspace.repositories.worktrees(AbortSignal.any([AbortSignal.timeout(120000), workspace.repositoryStop.signal]));
  const users = new Map(workspace.board.view().tasks.filter(task => task.worktree).map(task => [task.worktree!, task.id]));
  return {
    worktreeDirectory: workspace.settings.value.repositories.worktreeDirectory ?? null,
    repositories: repositories.map(item => ({ ...item, worktrees: item.worktrees.map(worktree => ({ ...worktree, taskId: worktree.path ? users.get(worktree.path) ?? null : null })) })),
  };
}

/**
   * Remove retained worktrees that no file task uses. Clean ones only, unless the
   * operator confirms discarding changes; a dry run reports without removing.
   */
export async function pruneWorktrees(workspace: WorkspaceContext, input: unknown){
  const body = object(input, "Worktree prune", ["action", "id", "repositoryId", "dryRun", "discardChanges"]);
  if (body.action !== "prune") throw new DomainError("invalid_input", "Worktree action: prune");
  if (body.id !== undefined && (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id))) throw new DomainError("invalid_input", "Use a worktree name from worktrees list.");
  if (body.repositoryId !== undefined) identifier(body.repositoryId, "Repository id");
  for (const flag of ["dryRun", "discardChanges"]) if (body[flag] !== undefined && typeof body[flag] !== "boolean") throw new DomainError("invalid_input", `${flag} must be true or false.`);
  const dryRun = body.dryRun === true;
  if (!workspace.acceptingTasks || workspace.repositoriesUpdating || workspace.configurationUpdating || workspace.executionProfiles?.pending())
    throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
  // Running work and admissions may be creating or using a worktree that no task records yet.
  if (!dryRun && (workspace.repositoryPreparations || workspace.sessions.busy || workspace.board.active || workspace.sharedRuntime.intake.busy || workspace.get().activeTasks.length || workspace.get().queuedTasks?.length))
    throw new DomainError("conflict", "Finish or cancel queued and running tasks before pruning task worktrees; a dry run is available now.");
  // Reserve synchronously before listing: all admission and configuration paths use this gate.
  if (!dryRun) workspace.configurationUpdating = true;
  workspace.repositoryPreparations++;
  try {
    const listing = await worktrees(workspace), results: Array<Record<string, unknown>> = [];
    for (const repository of listing.repositories) {
      if (body.repositoryId !== undefined && repository.repositoryId !== body.repositoryId) continue;
      for (const worktree of repository.worktrees) {
        if (body.id !== undefined && worktree.name !== body.id) continue;
        const entry = { repositoryId: repository.repositoryId, name: worktree.name, path: worktree.path ?? null, taskKey: worktree.taskKey ?? null };
        const taskId = worktree.taskId ?? workspace.board.view().tasks.find(task => task.worktree === worktree.path)?.id;
        if (taskId) { if (body.id !== undefined) results.push({ ...entry, outcome: "kept", reason: "A file task uses this worktree. Delete the task to remove it." }); continue; }
        if (worktree.state === "invalid") { results.push({ ...entry, outcome: "kept", reason: "Its ownership record is invalid. Review it manually." }); continue; }
        try {
          results.push({ ...entry, ...await workspace.repositories.removeWorktree(repository.repositoryId, { name: worktree.name }, AbortSignal.any([AbortSignal.timeout(WORKTREE_CHECKOUT_TIMEOUT_MS), workspace.repositoryStop.signal]), { dryRun, discardChanges: body.discardChanges === true }) });
        } catch (error) {
          const failure = worktreeFailure(error);
          results.push({ ...entry, outcome: "kept", reason: failure instanceof DomainError ? failure.message : "The worktree could not be removed." });
        }
      }
    }
    if (body.id !== undefined && !results.length) throw new DomainError("not_found", "No retained task worktree has this name.");
    return { dryRun, results, errors: listing.repositories.filter(item => item.error).map(item => ({ repositoryId: item.repositoryId, error: item.error })) };
  } finally { workspace.repositoryPreparations--; if (!dryRun) workspace.configurationUpdating = false; }
}
