import { assertNativeWorkReady } from './workspace-native-work.js';
import { executionRecoveryCommand } from './workspace-execution-recovery.js';
import { deliveryPolicyActions, deliveryPolicyCommand } from './workspace-delivery-policy.js';
import { deliveryMetrics } from './workspace-delivery-metrics.js';
import { publicationView, publishRequest } from './workspace-publication.js';
import { remotePublicationCommands } from '../application/remote-delivery-contracts.js';
import { serviceActive } from '../application/service-policy.js';
import { minimumClaudeVersion } from '../infrastructure/provider-version.js';
import { delegationLimits } from '../application/delegation-policy.js';
import { isSharedFeatureSession } from './workspace-feature-authoring.js';
import type { WorkspaceContext } from './workspace-context.js';
import { requestGateSchema } from '../application/request-gate-schema.js';
import { requestDispatchStatus } from '../application/request-dispatch.js';
import { defaultGatePolicy, gateFacts, type RequestCommand } from "../application/request-gates.js";
import { modelCapabilities } from "../application/model-contract.js";
import type { RunQuery } from "../application/run-evidence.js";
import { object, identifier } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import { assertTaskCanContinue } from './workspace-task-views.js';

export function capabilities(workspace: WorkspaceContext){
  return {
    schemaVersion: 1,
    scope: "worker_local_model_wrapper",
    interactionProtocol: 1,
    requests: {
      schemaVersion: 1,
      deterministicGates: true,
      policyFormat: "bounded_json_rules",
      stages: ["ready", "done"],
      rework: ["operator", "llm"],
      events: "polling",
      scope: "this_worker_accepted_requests",
      mergeAuthority: false,
    },
    events: { transport: "polling", streaming: false },
    // Retain the v1 wrapper profile; session-aware callers inspect the additive v2 profiles.
    capabilities: modelCapabilities,
    modelSessions: {
      requestVersions: [1, 2],
      scope: "per_feature_request",
      history: "worker_private_journal",
      context: "bounded_replay_with_explicit_archive",
      recovery: "explicit_guarded_resume",
      providers: {
        "claude-cli": { v2Continuation: "provider_session", nativeResume: true, minimumVersion: minimumClaudeVersion },
        "codex-cli": { v2Continuation: "worker_context_replay", nativeResume: false },
        "openai-api": { v2Continuation: "worker_context_replay", nativeResume: false },
        "anthropic-api": { v2Continuation: "worker_context_replay", nativeResume: false },
      },
      delegation: { tool: "werk_delegate", default: "disabled", ...delegationLimits, depth: 1, consumption: "per_child_invocation" },
    },
    toolAccess: { supported: true, management: "worker_global_revision", default: "none", scope: "local_model_invocations", repositoryFiles: "task_worktree_read_only", implementation: { supported: true, activation: "new_git_request_with_approved_paths_and_required_checks", writes: "approved_paths_in_owned_worktree", review: "actual_patch_and_matching_required_checks", humanMergeRequired: true }, cliTools: "argument_policy_in_task_worktree", executionLimits: "operator_configured_per_grant", revocation: "pause_and_drain_before_save" },
    consumption: { supported: true, unit: 'tokens', periods: ['daily', 'monthly'], clock: 'UTC', scope: 'this_worker_model_invocations', enforcement: 'admission', personalUsageObserved: false },
    resources: {
      supported: true,
      scope: "worker_node_process",
      events: "polling",
      sampleIntervalMs: 10000,
      automaticActions: false,
    },
    repositories: { supported: true, synchronization: "fetch_fast_forward_only", workspaces: "git_worktrees", publication: false },
    sharedIntake: { supported: true, claims: 'remote_git_compare_and_swap', workspaces: 'isolated_worktrees', publication: 'feature_branches_and_obsidian_notes', humanMergeRequired: true },
    projectIntegrations: {
      supported: true,
      enabled: !!(
        workspace.config.integrationProjectDir ?? workspace.config.projectDir
      ),
      inspection: "read_only",
      synchronization: "expected_plan",
      automaticExecution: false,
    },
  };
}

export async function requestCommand(workspace: WorkspaceContext, input: unknown){
  const selectedAction = input && typeof input === 'object' && !Array.isArray(input) ? (input as { action?: unknown }).action : undefined;
  if (deliveryPolicyActions.some(action => action === selectedAction)) return deliveryPolicyCommand(workspace, input);
  if (selectedAction === 'metrics') return deliveryMetrics(workspace, input);
  if (selectedAction === 'execution_recovery' || selectedAction === 'confirm_execution_stopped') return executionRecoveryCommand(workspace, input);
  const initial = object(input, "Request command", [
    "action",
    "sessionId",
    "requestId",
    "limit",
    "offset",
    "after",
    "expectedRevision",
    "operationId",
    "policy",
    "stage",
    "assignee",
    "note",
    "findingId",
    "input",
    "candidateId",
    "inputHash",
    "outputDigest",
    "deliveryRunId", "inputRevision", "candidateCommit", "candidateDigest", "humanOutcomes",
    "assessmentId", "proposalId", "decision", "criterionDecision", "reviewDurationMinutes", "publicationOperationId",
  ]);
  const action = String(initial.action);
  const reads: Record<string, string[]> = {
    list: ["action", "sessionId", "limit", "offset"],
    get: ["action", "requestId"],
    events: ["action", "requestId", "after", "limit"],
    schema: ["action"],
    policy: ["action"],
    publication: ["action", "requestId"],
    set_policy: ["action", "policy", "expectedRevision", "operationId"],
    execute: ["action", "requestId", "expectedRevision", "operationId"],
  };
  if (
    reads[action] &&
    Object.keys(initial).some((key) => !reads[action]!.includes(key))
  )
    throw new DomainError(
      "invalid_input",
      "Use the documented fields for this request action.",
    );
  const gates = workspace.sessions.requests;
  if (action === "schema")
    return {
      schemaVersion: 1,
      jsonSchema: requestGateSchema,
      facts: gateFacts,
      operators: ["eq", "neq", "gte", "lte"],
      stages: ["ready", "done"],
      defaultPolicy: defaultGatePolicy(),
      unknown: "fails_closed",
      operatorAttestation:
        "explicit_operator_decision_not_proof_of_human_identity",
    };
  if (action === "policy") return gates.policy();
  if (action === "publication") return publicationView(workspace, identifier(initial.requestId, "requestId"));
  if (action === "list")
    return gates.list({
      sessionId: initial.sessionId as string | undefined,
      limit: initial.limit as number | undefined,
      offset: initial.offset as number | undefined,
    });
  if (action === "get")
    return gates.get(identifier(initial.requestId, "requestId"));
  if (action === "events")
    return gates.events(
      identifier(initial.requestId, "requestId"),
      initial.after as number | undefined,
      initial.limit as number | undefined,
    );
  if (action !== "set_policy") {
    const replay = gates.replayCommand(initial as unknown as RequestCommand);
    if (replay) return { ...replay, dispatch: requestDispatchStatus(replay.request, action) };
  }
  if (!workspace.acceptingTasks)
    throw new DomainError("unavailable", "Worker is stopping.");
  if (!["cancel", "interrupt", "pause_after_step", "confirm_stopped"].includes(action) && (workspace.configurationUpdating || workspace.executionProfiles?.pending()))
    throw new DomainError("conflict", "Finish the execution profile change before starting new work.");
  if (action === "set_policy")
    return gates.setPolicy({
      policy: initial.policy,
      expectedRevision: initial.expectedRevision as number,
      operationId: initial.operationId as string,
    });
  const requestId = identifier(initial.requestId, "requestId");
  const before = gates.get(requestId);
  if (remotePublicationCommands.includes(action as typeof remotePublicationCommands[number])) return publishRequest(workspace, initial as unknown as RequestCommand);
  if (isSharedFeatureSession(workspace, before.owner.sessionId) && ['propose', 'accept_candidate', 'rework', 'execute'].includes(action))
    throw new DomainError('conflict', 'This Feature Request retains its published scope and checks. Use its Task answer or resume control to continue; publish a new Feature Request for a scope change.');
  if (
    before.owner.remote &&
    ["propose", "accept_candidate", "execute"].includes(action)
  )
    throw new DomainError(
      "conflict",
      "Remote assignments require an explicit upstream successor with a fresh lease and pinned context.",
    );
  if (['propose', 'accept_candidate', 'execute'].includes(action)) assertTaskCanContinue(workspace, before.owner.sessionId);
  if (before.input.kind === 'patch' && ['criterion_decision', 'attest', 'request_changes', 'confirm_stopped', 'execute', 'resume', 'retry', 'accept_candidate', 'readiness_decision'].includes(action)) assertNativeWorkReady(workspace);
  if (action === "criterion_decision") await workspace.board.verifyDeliveryCheckpoint(requestId, before.revision);
  if (["attest", "request_changes"].includes(action) && before.delivery?.review) await workspace.board.verifyDelivery(requestId, before.revision);
  const assertNoLiveServices = () => {
    if (workspace.processes?.status().services.some(service => service.sessionId === before.owner.sessionId && serviceActive(service.state)))
      throw new DomainError('conflict', 'Stop this request’s managed development services before confirming stopped processes.');
  };
  if (action === "confirm_stopped") assertNoLiveServices();
  const stopObservation = action === "confirm_stopped" ? await workspace.board.inspectStopped(requestId, before.revision) : undefined;
  if (action === "confirm_stopped") assertNoLiveServices();
  const result = gates.command(initial as unknown as RequestCommand, stopObservation);
  if (!result.duplicate && action === "cancel")
    workspace.reviews.cancel(requestId);
  if (
    !result.duplicate &&
    (["execute", "accept_candidate", "resume", "retry", "criterion_decision", "readiness_decision"].includes(action))
  ) {
    const current = gates.get(requestId);
    if (current.phase === "ready" || ["resume", "retry"].includes(action)) {
      try {
        if (current.input.kind === "patch") await workspace.board.executeRequest(requestId);
        else await workspace.sessions.executeRequest(requestId);
      } catch (error) {
        const code = error instanceof DomainError ? error.code : 'unavailable';
        const explanation = error instanceof DomainError ? error.message + ' ' : '';
        throw new DomainError(code, explanation + 'The request command was saved, but dispatch did not finish. Read the current request; if this input remains ready, issue a new guarded execute with a new operation ID.');
      }
    }
  }
  workspace.reviews.tick();
  const request = gates.get(requestId);
  return { ...result, request, dispatch: requestDispatchStatus(request, action) };
}

export function resourceEvents(workspace: WorkspaceContext, input: unknown){
  const body = object(input, "Resource query", ["action", "after", "limit"]);
  if (body.action !== "events")
    throw new DomainError("invalid_input", "Use the resource events action.");
  return workspace.resources.events(
    body.after as number | undefined,
    body.limit as number | undefined,
  );
}

export function runEvidence(workspace: WorkspaceContext, input: unknown){
  const body = object(input, "Run evidence query", [
    "action",
    "id",
    "sessionId",
    "taskId",
    "provider",
    "kind",
    "purpose",
    "outcome",
    "since",
    "until",
    "limit",
    "offset",
    "cursor",
    "asOf",
  ]);
  const { action, id, ...query } = body;
  if (action === "get") return workspace.sessions.runs.get(String(id ?? ""));
  if (id !== undefined)
    throw new DomainError("invalid_input", "A run ID is only used with get.");
  if (action === "list" || action === "export")
    return workspace.sessions.runs.list(query as RunQuery);
  if (action === "analyze")
    return workspace.sessions.runs.analyze(query as RunQuery);
  throw new DomainError(
    "invalid_input",
    "Run action: list|get|analyze|export",
  );
}
