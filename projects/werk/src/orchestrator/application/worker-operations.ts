import { validateRequestGateEvidence } from "../../shared/request-gate.js";
import {
  identifier,
  object,
  repositoryScope,
  workerProfilesUpdate,
} from "../../shared/contracts.js";
import type { ContextManifest } from "../../shared/context.js";
import { DomainError } from "../../shared/errors.js";
import type { Task } from "../../shared/contracts.js";
import type { WorkerRecord, WorkerProfilesResponse } from "../../shared/protocol.js";
import type { OrchestratorRepository, WorkerAction } from "./ports.js";

/** A resolved identity cannot be replaced by a worker ID supplied in a request body. */
export class WorkerOperations {
  private readonly repository: OrchestratorRepository;
  private readonly identity: WorkerRecord;

  constructor(repository: OrchestratorRepository, identity: WorkerRecord) {
    this.repository = repository;
    this.identity = identity;
  }

  current() {
    return { tasks: this.repository.current(this.identity) };
  }

  updateProfiles(input: unknown): WorkerProfilesResponse {
    const update = workerProfilesUpdate(input);
    if (!this.repository.updateProfiles) throw new DomainError('unavailable', 'Worker profile updates are unavailable.');
    return this.repository.updateProfiles(this.identity, update);
  }

  claim(input: unknown) {
    const body = object(input, "Assignment request", [
      "requestId",
      "queueCapacity",
      "repositoryIds",
      "legacyRepository",
    ]);
    if (
      typeof body.requestId !== "string" ||
      !/^[\w-]{1,100}$/.test(body.requestId)
    ) {
      throw new DomainError(
        "invalid_input",
        "requestId required: 1–100 letters, digits, _ or -",
      );
    }
    if (
      body.queueCapacity !== undefined &&
      (!Number.isInteger(body.queueCapacity) ||
        Number(body.queueCapacity) < 0 ||
        Number(body.queueCapacity) > 64)
    )
      throw new DomainError("invalid_input", "queueCapacity: 0–64");
    const scope = repositoryScope(body.repositoryIds, body.legacyRepository);
    return {
      task: this.repository.claim(
        this.identity,
        body.requestId,
        body.queueCapacity as number | undefined,
        scope.repositoryIds,
        scope.legacyRepository,
      ),
    };
  }

  snapshot(input: unknown) {
    return this.repository.snapshot(this.identity, input);
  }

  context(taskId: string, input: unknown): ContextManifest {
    const body = object(input, "Context assignment", ["lease", "attempt"]);
    if (
      typeof body.lease !== "string" ||
      !body.lease ||
      !Number.isSafeInteger(body.attempt) ||
      Number(body.attempt) < 1
    ) {
      throw new DomainError(
        "invalid_input",
        "lease string and positive integer attempt required",
      );
    }
    return this.repository.workerContext(
      this.identity,
      taskId,
      body.lease,
      body.attempt as number,
    );
  }

  execute(action: WorkerAction, taskId: string, input: unknown): Task {
    const body = object(
      input,
      "Lease command",
      action === "resolve-hold"
        ? ["lease", "attempt", "heldEvaluationId", "gate"]
        : action === "hold"
          ? ["lease", "attempt", "gate"]
          : ["lease", "attempt"],
    );
    if (
      typeof body.lease !== "string" ||
      !body.lease ||
      !Number.isSafeInteger(body.attempt) ||
      Number(body.attempt) < 1
    ) {
      throw new DomainError(
        "invalid_input",
        "lease string and positive integer attempt required",
      );
    }
    if (action === "resolve-hold") {
      if (!this.repository.resolveHold)
        throw new DomainError(
          "unavailable",
          "Request gate hold resolution is unsupported by this orchestrator.",
        );
      return this.repository.resolveHold(
        this.identity,
        taskId,
        body.lease,
        body.attempt,
        identifier(body.heldEvaluationId, "heldEvaluationId"),
        validateRequestGateEvidence(body.gate),
      );
    }
    if (action === "hold") {
      if (!this.repository.hold)
        throw new DomainError(
          "unavailable",
          "Request gate hold is unsupported by this orchestrator.",
        );
      return this.repository.hold(
        this.identity,
        taskId,
        body.lease,
        body.attempt,
        validateRequestGateEvidence(body.gate),
      );
    }
    switch (action) {
      case "heartbeat":
        return this.repository.heartbeat(
          this.identity,
          taskId,
          body.lease,
          body.attempt,
        );
      case "complete":
        return this.repository.finish(
          this.identity,
          taskId,
          body.lease,
          body.attempt,
        );
      case "abandon":
        return this.repository.abandon(
          this.identity,
          taskId,
          body.lease,
          body.attempt,
        );
    }
  }
}
