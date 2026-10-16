import type { Snapshot } from "../../shared/snapshots.js";
import { DomainError } from "../../shared/errors.js";
import type { Task, Adapter } from "../../shared/contracts.js";
import type { RequestGateEvidence } from "../../shared/request-gate.js";
import type { AttemptRequestGates } from "./ports.js";
import type { ModelProvider } from "./model-contract.js";
import type { RemoteRequestGatePort } from "./journal-ports.js";
import type { GateEvaluation, WorkerRequest } from "./request-gates.js";

type Result = Awaited<ReturnType<Adapter["run"]>>;
/** A remote lease has its own snapshot pair; the request remains stable across reassignment. */
export class RemoteRequestGates implements AttemptRequestGates {
  private readonly journal: RemoteRequestGatePort;
  private readonly origin: string;
  private readonly provider: (task: Task) => ModelProvider;
  private readonly approvedPaths: readonly string[];
  constructor(
    journal: RemoteRequestGatePort,
    origin: string,
    provider: (task: Task) => ModelProvider,
    approvedPaths: readonly string[] = [],
  ) {
    this.journal = journal;
    this.origin = new URL(origin).origin;
    this.provider = provider;
    this.approvedPaths = approvedPaths;
  }
  private request(task: Task): WorkerRequest {
    const sessionId = "remote-" + task.id,
      rootTurnId = sessionId;
    const prior = this.journal.forTurn(sessionId, rootTurnId);
    if (prior) {
      if (
        prior.owner.remote?.origin !== this.origin ||
        prior.owner.remote.taskId !== task.id
      )
        throw new DomainError(
          "conflict",
          "Retained request belongs to another orchestrator.",
        );
      const accepted = prior.input.context as {
        context?: unknown;
        source?: unknown;
        repository?: string;
      };
      if (
        (accepted?.repository ?? null) !== (task.repository ?? null) ||
        prior.input.title !== task.title ||
        JSON.stringify(prior.input.criteria) !==
          JSON.stringify(task.criteria) ||
        JSON.stringify(accepted?.context ?? null) !==
          JSON.stringify(task.context ?? null) ||
        JSON.stringify(accepted?.source ?? null) !==
          JSON.stringify(task.source ?? null) ||
        prior.input.kind !==
          (task.executionMode === "cli" ? "patch" : "chat") ||
        (task.executionMode === "cli" &&
          JSON.stringify(prior.input.files?.map((file) => file.path)) !==
            JSON.stringify(this.approvedPaths))
      )
        throw new DomainError(
          "conflict",
          "Remote request context changed; create an explicit successor.",
        );
      return prior;
    }
    return this.journal.ensure({
      owner: {
        sessionId,
        rootTurnId,
        taskId: task.id,
        remote: {
          origin: this.origin,
          taskId: task.id,
          attempt: task.attempt,
          lease: task.lease!,
        },
      },
      input: {
        kind: task.executionMode === "cli" ? "patch" : "chat",
        title: task.title,
        message: task.title,
        criteria: task.criteria,
        ...(task.executionMode === "cli"
          ? { files: this.approvedPaths.map((path) => ({ path, bytes: null })) }
          : {}),
        context: {
          taskId: task.id,
          context: task.context ?? null,
          source: task.source ?? null,
          ...(task.repository ? { repository: task.repository } : {}),
        },
      },
      provider: this.provider(task),
    });
  }
  private receipt(
    request: WorkerRequest,
    evaluation: GateEvaluation,
  ): RequestGateEvidence {
    return {
      schemaVersion: 1,
      requestId: request.id,
      revision: this.journal.get(request.id).revision,
      inputDigest: evaluation.inputHash,
      policyDigest: evaluation.policyDigest,
      evaluationId: evaluation.id,
      stage: evaluation.stage,
      status: evaluation.passed ? "passed" : "blocked",
      failedRules: evaluation.rules.filter((rule) => rule.result === "fail")
        .length,
      unknownRules: evaluation.rules.filter((rule) => rule.result === "unknown")
        .length,
    };
  }
  async ready(task: Task) {
    let request = this.request(task);
    const execution = request.execution;
    if (
      request.phase === "cancelled" ||
      (execution &&
        (execution.turnId !== task.lease ||
          (!execution.result &&
            ["running", "interrupted", "prepared"].includes(execution.status))))
    ) {
      request = this.journal.holdRecovery(request.id, "checkpoint_ownership");
      return this.receipt(
        request,
        request.evaluations.findLast(
          (e) =>
            e.stage === "ready" && e.inputRevision === request.inputRevision,
        )!,
      );
    }
    // A known result from this lease is reconstructed, never dispatched again.
    if (
      execution?.result &&
      execution.turnId === task.lease &&
      !request.recoveryHold
    ) {
      const ready = request.evaluations.findLast(
        (e) => e.stage === "ready" && e.inputRevision === request.inputRevision,
      );
      if (ready) return this.receipt(request, ready);
    }
    return this.receipt(request, this.journal.evaluate(request.id, "ready"));
  }
  async recover(task: Task): Promise<Result | null> {
    const request = this.request(task),
      execution = request.execution;
    if (!execution?.result || execution.turnId !== task.lease) return null;
    if (execution.result.type !== "completed")
      throw Error("Invalid remote execution checkpoint.");
    const result = JSON.parse(execution.result.text) as Result;
    if (
      !result ||
      !["simulated", "change-set"].includes(result.kind) ||
      typeof result.summary !== "string"
    )
      throw Error("Invalid remote result checkpoint.");
    return result;
  }
  /** Startup only: recover validated durable results, never infer successful work from a running intent. */
  async recoverSnapshot(before: Snapshot): Promise<{
    outcome: "simulated" | "change-set" | "gate_blocked";
    requestGate: RequestGateEvidence;
    review?: Snapshot["review"];
  } | null> {
    const sessionId = "remote-" + before.taskId;
    const request = this.journal.forTurn(sessionId, sessionId);
    if (!request) return null;
    if (
      request.owner.remote?.origin !== this.origin ||
      request.owner.remote.taskId !== before.taskId
    )
      throw new DomainError(
        "conflict",
        "Retained request belongs to another orchestrator.",
      );
    const context = request.input.context as {
      context?: { sha256?: string; commit?: string };
    };
    if (
      (context?.context?.sha256 ?? null) !==
        before.provenance.contextManifestHash ||
      (context?.context?.commit ?? null) !==
        (before.provenance.contextManifestHash
          ? before.provenance.sourceCommit
          : null) ||
      request.input.kind !== (before.mode === "cli" ? "patch" : "chat")
    )
      throw new DomainError(
        "conflict",
        "Snapshot and retained request context disagree.",
      );
    const execution = this.journal.execution(request.id, before.pairId);
    if (execution?.result) {
      if (execution.result.type !== "completed")
        throw Error("Invalid remote execution checkpoint.");
      const result = JSON.parse(execution.result.text) as Result;
      if (
        !result ||
        typeof result.summary !== "string" ||
        result.kind !== (before.mode === "cli" ? "change-set" : "simulated") ||
        (result.kind === "change-set" && !result.review)
      )
        throw Error("Invalid remote result checkpoint.");
      const evaluation = request.evaluations.findLast(
        (e) =>
          e.stage === "done" &&
          e.inputRevision === execution.inputRevision &&
          e.outputDigest === execution.outputDigest,
      );
      if (!evaluation)
        throw Error(
          "Known remote result requires its durable completion evaluation.",
        );
      return {
        outcome: result.kind,
        requestGate: this.receipt(request, evaluation),
        ...(result.review ? { review: result.review } : {}),
      };
    }
    // An unknown started attempt remains interrupted. A failed readiness decision means no provider ran.
    if (execution) return null;
    const evaluation = request.evaluations.findLast(
      (e) => e.stage === "ready" && e.inputRevision === request.inputRevision,
    );
    if (evaluation && !evaluation.passed)
      return {
        outcome: "gate_blocked",
        requestGate: this.receipt(request, evaluation),
      };
    return null;
  }
  async start(task: Task) {
    const request = this.request(task),
      runId = "remote-" + task.lease;
    this.journal.bindTurn(request.id, task.lease!);
    this.journal.prepareExecution(request.id, task.lease!, runId);
    this.journal.startExecution(request.id, task.lease!, runId);
  }
  async completed(task: Task, result: Result) {
    const request = this.request(task),
      runId = "remote-" + task.lease;
    this.journal.recordResult(
      request.id,
      task.lease!,
      runId,
      { type: "completed", text: JSON.stringify(result) },
      {
        "output.nonEmpty": !!result.summary.trim(),
        "output.protocolValid": true,
        "output.patchPresent": result.kind === "change-set" && !!result.review,
      },
    );
    return this.receipt(
      this.journal.get(request.id),
      this.journal.evaluate(request.id, "done"),
    );
  }
  async failed(task: Task, outcome: "failed" | "interrupted") {
    const request = this.request(task);
    if (request.execution?.turnId === task.lease)
      this.journal.failExecution(request.id, task.lease!, outcome);
  }
}
