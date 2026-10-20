import type { RepositoryAssignment } from '../application/repositories.js';
import type { WorkspaceContext } from './workspace-context.js';
import type { ToolAccessView } from '../application/tool-policy.js';
import { BuiltinToolError, chatToolDirectory } from '../infrastructure/builtin-tools.js';
import { discoverMcpTools, mcpTransportConfiguration, McpClientError } from '../infrastructure/tool-mcp.js';
import { planProjectIntegrations, syncProjectIntegrations } from "../infrastructure/project-integrations.js";
import { object, identifier } from "../../shared/contracts.js";
import { join } from "node:path";
import { DomainError } from "../../shared/errors.js";
import { readBoundedFile } from "../infrastructure/journal/files.js";
import { assertRepositoryChangeAllowed } from './workspace-repositories.js';

export async function providerStatus(workspace: WorkspaceContext, input: unknown){
  const body = object(input, 'Provider status check', ['id']);
  return workspace.providerStatuses.check(workspace.settings.provider(String(body.id)));
}

export async function providerAccount(workspace: WorkspaceContext, input: unknown){
  const body = object(input, 'Provider account check', ['id']);
  return workspace.providerAccounts.check(workspace.settings.provider(identifier(body.id, 'provider ID')));
}

export function toolAccess(workspace: WorkspaceContext): ToolAccessView{
  const saveBlockedReason = toolAccessBlockedReason(workspace);
  return { ...workspace.settings.toolAccess(), canEdit: !saveBlockedReason, saveBlockedReason, workerNode: process.execPath };
}

export function toolAccessBlockedReason(workspace: WorkspaceContext): string | null{
  if (!workspace.acceptingTasks) return 'Worker is stopping.';
  if (workspace.configurationUpdating || workspace.repositoriesUpdating || workspace.executionProfiles?.pending()) return 'Finish the current worker configuration change first.';
  if (!workspace.settings.value.board.paused) return 'Pause new starts before changing tool access.';
  if (workspace.repositoryPreparations || workspace.sessions.busy || workspace.board.active || workspace.get().activeTasks.length || workspace.get().queuedTasks?.length) return 'Finish or cancel queued work and active replies before changing tool access.';
  return null;
}

export async function updateToolAccess(workspace: WorkspaceContext, input: unknown){
  const blocked = toolAccessBlockedReason(workspace);
  if (blocked) throw new DomainError('conflict', blocked);
  await withIdleConfiguration(workspace, () => workspace.settings.updateToolAccess(input));
  await workspace.processes?.reconcileGrants();
  return toolAccess(workspace);
}

export async function discoverToolAccess(workspace: WorkspaceContext, input: unknown){
  const body = object(input, 'MCP discovery', ['id', 'expectedRevision']);
  const id = identifier(body.id, 'MCP connection ID');
  const blocked = toolAccessBlockedReason(workspace);
  if (blocked) throw new DomainError('conflict', blocked);
  await withIdleConfiguration(workspace, async () => {
    const policy = workspace.settings.toolPolicy();
    if (body.expectedRevision !== policy.revision) throw new DomainError('conflict', 'Tool access changed. Reload before discovering tools.');
    const connection = policy.mcp.find(item => item.id === id);
    if (!connection) throw new DomainError('not_found', 'MCP connection not found.');
    let definitions;
    try {
      // Discovery and chat calls use the same checked directory, including the private default workspace.
      const directory = connection.transport === 'stdio'
        ? await chatToolDirectory({ directory: workspace.config.stateDir, repositories: () => workspace.settings.value.repositories.items })(connection)
        : undefined;
      definitions = await discoverMcpTools(mcpTransportConfiguration(connection), { signal: workspace.repositoryStop.signal, directory });
    }
    catch (error) {
      if (error instanceof BuiltinToolError) throw new DomainError('invalid_input', error.message);
      // MCP errors contain only worker-owned messages, never server diagnostics or credentials.
      if (error instanceof McpClientError) throw new DomainError(
        ['configuration', 'output_limit'].includes(error.reason) ? 'invalid_input' : 'unavailable', error.message,
      );
      throw error;
    }
    await workspace.settings.discoveredTools(id, policy.revision, definitions);
  });
  return toolAccess(workspace);
}

export async function withIdleConfiguration<T>(workspace: WorkspaceContext, operation: () => Promise<T>): Promise<T>{
  if (!workspace.acceptingTasks || workspace.configurationUpdating || workspace.featureProjects.busy || !workspace.settings.value.board.paused || workspace.repositoriesUpdating || workspace.repositoryPreparations || workspace.sessions.busy || workspace.board.active || workspace.get().activeTasks.length || workspace.get().queuedTasks?.length)
    throw new DomainError("conflict", "Pause intake and finish or cancel queued tasks and active replies before changing execution profiles.");
  workspace.configurationUpdating = true;
  try { return await operation(); } finally { workspace.configurationUpdating = false; }
}

export async function withRepositoryAdmission<T>(workspace: WorkspaceContext, operation: () => Promise<T>): Promise<T>{
  if (!workspace.acceptingTasks || workspace.repositoriesUpdating || workspace.configurationUpdating || workspace.executionProfiles?.pending())
    throw new DomainError("unavailable", "Worker configuration is changing or the worker is stopping.");
  workspace.repositoryPreparations++;
  try {
    return await operation();
  } finally {
    workspace.repositoryPreparations--;
  }
}

export async function updateSettings(workspace: WorkspaceContext, body: unknown){
  const input = body as Record<string, unknown>;
  if (workspace.configurationUpdating || (workspace.executionProfiles?.pending() && (input?.board as Record<string, unknown>)?.paused === false))
    throw new DomainError("conflict", "Finish the execution profile change before updating worker settings or resuming intake.");
  const update = async () => {
    if (input?.provider && (workspace.sessions.busy || workspace.board.active))
      throw new DomainError(
        "conflict",
        "Finish or stop queued tasks and active replies before changing providers.",
      );
    if (
      input?.connection &&
      (workspace.get().activeTasks.length || workspace.get().queuedTasks?.length)
    )
      throw new DomainError(
        "conflict",
        "Pause intake and drain orchestrator assignments before changing the connection.",
      );
    if (input?.connection) {
      const connection = input.connection as Record<string, unknown>;
      try {
        const identity = JSON.parse(
          await readBoundedFile(
            join(workspace.config.stateDir, "identity.json"),
            16384,
          ),
        );
        if (
          connection.url &&
          new URL(String(connection.url)).origin !==
            new URL(identity.url).origin
        )
          throw new DomainError(
            "conflict",
            "This identity is bound to another orchestrator. Use a separate worker state directory for another server.",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (input?.provider)
      return workspace.sessions.updateProviders(() => workspace.settings.update(body));
    return workspace.settings.update(body);
  };
  if (input?.repositories !== undefined) {
    const proposed = (input.repositories as { items?: { id?: unknown; path?: unknown }[] })?.items;
    if (workspace.featureProjects.busy) throw new DomainError('conflict', 'Wait for shared synchronization before changing repository assignments.');
    if (Array.isArray(proposed)) workspace.featureProjects.assertAssignments(proposed as RepositoryAssignment[]);
    assertRepositoryChangeAllowed(workspace);
    workspace.repositoriesUpdating = true;
    try {
      const result = await update();
      await workspace.repositoryDiscovery.assignmentsChanged(workspace.settings.value.repositories.items);
      await workspace.repositories.configure(workspace.settings.value.repositories);
      await workspace.featureProjects.configure();
      await workspace.processes?.reconcileGrants();
      return result;
    } finally { workspace.repositoriesUpdating = false; }
  }
  const result = await update();
  workspace.sessions.executor.wake();
  return result;
}

export async function integrations(workspace: WorkspaceContext, input: unknown = { action: "status" }){
  const body = object(input, "Project integration command", [
    "action",
    "expectedPlan",
  ]);
  if (
    !["status", "plan", "apply"].includes(String(body.action)) ||
    (body.action !== "apply" && body.expectedPlan !== undefined)
  )
    throw new DomainError(
      "invalid_input",
      "Use status, plan or apply with the documented fields.",
    );
  const projectDirectory =
    workspace.config.integrationProjectDir ?? workspace.config.projectDir;
  if (!projectDirectory) {
    if (body.action === "apply")
      throw new DomainError(
        "conflict",
        "Start an installed project worker or configure its project directory before synchronizing integrations.",
      );
    return {
      schemaVersion: 1 as const,
      enabled: false as const,
      reason: "Project integrations require a configured project directory.",
    };
  }
  if (body.action === "apply") {
    if (
      typeof body.expectedPlan !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.expectedPlan)
    )
      throw new DomainError(
        "invalid_input",
        "Apply requires the current 64-character expectedPlan identifier.",
      );
    return {
      ...(await syncProjectIntegrations(projectDirectory, body.expectedPlan)),
      enabled: true as const,
    };
  }
  return {
    ...(await planProjectIntegrations(projectDirectory)),
    enabled: true as const,
  };
}
