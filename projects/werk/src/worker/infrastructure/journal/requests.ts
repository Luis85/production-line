import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from "node:crypto";
import { DomainError } from "../../../shared/errors.js";
import { openPrivateJournal } from './database.js';
import {
  defaultGatePolicy,
  evaluateGate,
  gateDigest,
  gateIdentifier,
  inputGateFacts,
  validateGateFacts,
  validateGateInput,
  validateGatePolicy,
  type GateEvaluation,
  type GateFactSnapshot,
  type GateInput,
  type GateReviewIntent,
  type GateStage,
  type RequestCandidate,
  type RequestCommand,
  type RequestEvent,
  type RequestGatePort,
  type RequestOwner,
  type RequestSummary,
  type WorkerRequest,
} from "../../application/request-gates.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
} from "../../application/model-contract.js";
import type { ProviderUsage } from "../../application/run-evidence.js";
import { unknownUsage } from "../../application/run-evidence.js";
function normalizeUsage(value: ProviderUsage): ProviderUsage {
  const normalized = unknownUsage();
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "providerReportedCostUsd",
  ] as const) {
    const number = value[key];
    normalized[key] =
      typeof number === "number" &&
      Number.isFinite(number) &&
      number >= 0 &&
      (key === "providerReportedCostUsd"
        ? number <= 1e9
        : Number.isSafeInteger(number) && number <= 1e12)
        ? number
        : null;
  }
  normalized.source = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "providerReportedCostUsd",
  ].some((key) => (normalized as any)[key] !== null)
    ? "provider_reported"
    : "unavailable";
  normalized.costBasis =
    normalized.providerReportedCostUsd === null
      ? "unavailable"
      : ["reported_estimate", "reported_billed", "unknown"].includes(
            value.costBasis ?? "",
          )
        ? value.costBasis
        : "unknown";
  if (normalized.source === "provider_reported") normalized.reason = null;
  return normalized;
}

const clone = <T>(value: T): T => structuredClone(value);
function invalid(message: string): never {
  throw new DomainError("invalid_input", message);
}
function conflict(message: string): never {
  throw new DomainError("conflict", message);
}
const iso = () => new Date().toISOString();
function identifier(value: unknown, label: string): string {
  if (!gateIdentifier(value)) invalid(`Invalid ${label}.`);
  return value as string;
}
function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const chosen = value === undefined ? fallback : value;
  if (
    !Number.isSafeInteger(chosen) ||
    Number(chosen) < min ||
    Number(chosen) > max
  )
    invalid("Pagination requires bounded nonnegative integers.");
  return Number(chosen);
}
function provider(value: ModelProvider): ModelProvider {
  if (
    !value ||
    !gateIdentifier(value.id) ||
    typeof value.model !== "string" ||
    value.model.length > 200 ||
    typeof value.instruction !== "string" ||
    value.instruction.length > 64000 ||
    Object.keys(value).some(
      (key) => !["id", "model", "instruction"].includes(key),
    )
  )
    invalid("Invalid request provider metadata.");
  return clone(value);
}
function owner(value: RequestOwner): RequestOwner {
  if (
    !value ||
    Object.keys(value).some(
      (key) =>
        !["sessionId", "rootTurnId", "taskId", "featureId", "remote"].includes(
          key,
        ),
    )
  )
    invalid("Invalid request owner.");
  identifier(value.sessionId, "session ID");
  identifier(value.rootTurnId, "root intent ID");
  if (value.taskId !== undefined) identifier(value.taskId, "task ID");
  if (value.featureId !== undefined) identifier(value.featureId, "feature ID");
  if (value.remote) {
    const remote = value.remote;
    if (
      Object.keys(remote).some(
        (key) => !["origin", "taskId", "attempt", "lease"].includes(key),
      )
    )
      invalid("Invalid remote owner.");
    let url: URL;
    try {
      url = new URL(remote.origin);
    } catch {
      return invalid("Invalid owning orchestrator origin.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin !== remote.origin
    )
      invalid("Use the credential-free owning orchestrator origin.");
    identifier(remote.taskId, "remote task ID");
    identifier(remote.lease, "lease ID");
    boundedInteger(remote.attempt, 0, 1, Number.MAX_SAFE_INTEGER);
  }
  return clone(value);
}
function summary(request: WorkerRequest): RequestSummary {
  const {
    id,
    owner,
    revision,
    inputRevision,
    inputHash,
    policyDigest,
    phase,
    assignee,
    updatedAt,
  } = request;
  return {
    id,
    owner,
    revision,
    inputRevision,
    inputHash,
    policyDigest,
    phase,
    title: request.input.title,
    kind: request.input.kind,
    assignee,
    updatedAt,
  };
}

/** Authoritative request state. Other journals are projections/replay evidence, never one cross-file transaction. */
export class WorkerRequestJournal implements RequestGatePort {
  private directory: string;
  private db?: DatabaseSync;
  constructor(directory: string) {
    this.directory = directory;
  }
  async init() {
    if (this.db) return;
    this.db = await openPrivateJournal(this.directory, 'worker-requests.sqlite', 'Request journal must be a regular file.');
    try {
      this.db
        .exec(`
        CREATE TABLE IF NOT EXISTS worker_requests(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,root_turn_id TEXT NOT NULL,phase TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(session_id,root_turn_id));
        CREATE TABLE IF NOT EXISTS request_generations(request_id TEXT NOT NULL,input_revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(request_id,input_revision));
        CREATE TABLE IF NOT EXISTS request_turns(session_id TEXT NOT NULL,turn_id TEXT NOT NULL,request_id TEXT NOT NULL,input_revision INTEGER NOT NULL,PRIMARY KEY(session_id,turn_id));
        CREATE TABLE IF NOT EXISTS request_executions(request_id TEXT NOT NULL,turn_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(request_id,turn_id));
        CREATE TABLE IF NOT EXISTS request_operations(request_id TEXT NOT NULL,operation_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(request_id,operation_id));
        CREATE TABLE IF NOT EXISTS request_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS request_events_owner ON request_events(request_id,sequence);
        CREATE INDEX IF NOT EXISTS request_sessions ON worker_requests(session_id,sequence);
        CREATE TABLE IF NOT EXISTS request_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS request_policy_operations(operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL);`);
      for (const row of this.database()
        .prepare("SELECT payload FROM worker_requests")
        .all()) {
        const request = JSON.parse(String(row.payload)) as WorkerRequest;
        let changed = false;
        if (
          request.execution &&
          ["prepared", "running"].includes(request.execution.status) &&
          !request.execution.result
        ) {
          request.execution.status = "interrupted";
          request.execution.outcome = "interrupted";
          request.phase = "interrupted";
          changed = true;
        }
        for (const review of request.reviews)
          if (review.status === "running") {
            review.status = "interrupted";
            review.errorCode = "worker_restarted";
            review.finishedAt = iso();
            changed = true;
          }
        if (changed)
          this.transaction(() => this.save(request, "recovered_interrupted"));
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
  private database() {
    if (!this.db) throw Error("Request journal is not open.");
    return this.db;
  }
  private transaction<T>(action: () => T): T {
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  private save(
    request: WorkerRequest,
    type: string,
    detail: Pick<RequestEvent, "evaluationId" | "turnId" | "runId"> = {},
  ) {
    request.revision++;
    request.updatedAt = iso();
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload) > 16777216)
      conflict(
        "Request history reached its bounded private record size. Create a linked new request.",
      );
    this.database()
      .prepare("UPDATE worker_requests SET phase=?,payload=? WHERE id=?")
      .run(request.phase, payload, request.id);
    if (request.execution) {
      const previous = this.database()
        .prepare(
          "SELECT payload FROM request_executions WHERE request_id=? AND turn_id=?",
        )
        .get(request.id, request.execution.turnId);
      if (previous) {
        const retained = JSON.parse(String(previous.payload));
        if (
          retained.result &&
          retained.outputDigest !== request.execution.outputDigest
        )
          conflict("A historical execution result is immutable.");
      }
      this.database()
        .prepare(
          "INSERT INTO request_executions(request_id,turn_id,payload) VALUES(?,?,?) ON CONFLICT(request_id,turn_id) DO UPDATE SET payload=excluded.payload",
        )
        .run(
          request.id,
          request.execution.turnId,
          JSON.stringify(request.execution),
        );
    }
    const event: RequestEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      sequence: 0,
      requestId: request.id,
      revision: request.revision,
      type,
      phase: request.phase,
      at: request.updatedAt,
      inputRevision: request.inputRevision,
      ...detail,
    };
    const result = this.database()
      .prepare(
        "INSERT INTO request_events(id,request_id,payload) VALUES(?,?,?)",
      )
      .run(event.id, request.id, "{}");
    event.sequence = Number(result.lastInsertRowid);
    this.database()
      .prepare("UPDATE request_events SET payload=? WHERE sequence=?")
      .run(JSON.stringify(event), event.sequence);
  }
  private generation(request: WorkerRequest) {
    this.database()
      .prepare(
        "INSERT INTO request_generations(request_id,input_revision,payload) VALUES(?,?,?)",
      )
      .run(
        request.id,
        request.inputRevision,
        JSON.stringify({
          input: request.input,
          inputHash: request.inputHash,
          policy: request.policy,
          policyDigest: request.policyDigest,
          provider: request.provider,
          at: request.updatedAt,
        }),
      );
  }
  get(id: string): WorkerRequest {
    identifier(id, "request ID");
    const row = this.database()
      .prepare("SELECT payload FROM worker_requests WHERE id=?")
      .get(id);
    if (!row) throw new DomainError("not_found", "Request not found.");
    return JSON.parse(String(row.payload));
  }
  execution(id: string, turnId: string) {
    this.get(id);
    identifier(turnId, "turn ID");
    const row = this.database()
      .prepare(
        "SELECT payload FROM request_executions WHERE request_id=? AND turn_id=?",
      )
      .get(id, turnId);
    return row
      ? (JSON.parse(String(row.payload)) as NonNullable<
          WorkerRequest["execution"]
        >)
      : undefined;
  }
  hasActiveReview(sessionId: string): boolean {
    return this.database()
      .prepare("SELECT payload FROM worker_requests WHERE session_id=?")
      .all(sessionId)
      .some((row) =>
        (JSON.parse(String(row.payload)) as WorkerRequest).reviews.some(
          (review) => ["queued", "running"].includes(review.status),
        ),
      );
  }
  forSession(sessionId: string): WorkerRequest | undefined {
    identifier(sessionId, "session ID");
    const row = this.database()
      .prepare(
        "SELECT payload FROM worker_requests WHERE session_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(sessionId);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  forTurn(sessionId: string, turnId: string): WorkerRequest | undefined {
    identifier(sessionId, "session ID");
    identifier(turnId, "turn ID");
    const row = this.database()
      .prepare(
        "SELECT request_id FROM request_turns WHERE session_id=? AND turn_id=?",
      )
      .get(sessionId, turnId);
    if (row) return this.get(String(row.request_id));
    const root = this.database()
      .prepare(
        "SELECT payload FROM worker_requests WHERE session_id=? AND root_turn_id=?",
      )
      .get(sessionId, turnId);
    return root ? JSON.parse(String(root.payload)) : undefined;
  }
  list(
    options: {
      sessionId?: string;
      phase?: string;
      limit?: number;
      after?: number;
      offset?: number;
    } = {},
  ) {
    const offset = boundedInteger(
      options.offset,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (options.offset !== undefined && options.after !== undefined)
      invalid("Choose offset or after pagination, not both.");
    const limit = boundedInteger(options.limit, 50, 1, 100),
      after = boundedInteger(options.after, 0, 0, Number.MAX_SAFE_INTEGER);
    if (options.sessionId !== undefined)
      identifier(options.sessionId, "session ID");
    if (
      options.phase !== undefined &&
      ![
        "readiness",
        "needs_rework",
        "ready",
        "running",
        "waiting_input",
        "escalated",
        "review",
        "done",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(options.phase)
    )
      invalid("Unknown request phase.");
    const clauses = ["sequence>?"],
      params: (string | number)[] = [after];
    if (options.sessionId) {
      clauses.push("session_id=?");
      params.push(options.sessionId);
    }
    if (options.phase) {
      clauses.push("phase=?");
      params.push(options.phase);
    }
    const total = Number(
      this.database()
        .prepare(
          `SELECT COUNT(*) AS count FROM worker_requests WHERE ${clauses.join(" AND ")}`,
        )
        .get(...params)!.count,
    );
    const rows = this.database()
      .prepare(
        `SELECT sequence,payload FROM worker_requests WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ? OFFSET ?`,
      )
      .all(...params, limit + 1, offset);
    const selected = rows.slice(0, limit);
    return {
      schemaVersion: 1 as const,
      rows: selected.map((row) => summary(JSON.parse(String(row.payload)))),
      total,
      nextOffset: rows.length > limit ? offset + limit : null,
      requests: selected.map((row) => summary(JSON.parse(String(row.payload)))),
      nextAfter: selected.length ? Number(selected.at(-1)!.sequence) : after,
      hasMore: rows.length > limit,
    };
  }
  events(id: string, after = 0, limit = 100) {
    this.get(id);
    after = boundedInteger(after, 0, 0, Number.MAX_SAFE_INTEGER);
    limit = boundedInteger(limit, 100, 1, 100);
    const rows = this.database()
      .prepare(
        "SELECT payload,sequence FROM request_events WHERE request_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(id, after, limit + 1);
    const selected = rows.slice(0, limit);
    return {
      schemaVersion: 1 as const,
      requestId: id,
      events: selected.map(
        (row) => JSON.parse(String(row.payload)) as RequestEvent,
      ),
      nextAfter: selected.length ? Number(selected.at(-1)!.sequence) : after,
      hasMore: rows.length > limit,
    };
  }
  ensure(input: {
    owner: RequestOwner;
    input: GateInput;
    provider: ModelProvider;
    policy?: WorkerRequest["policy"];
  }): WorkerRequest {
    const owned = owner(input.owner),
      accepted = validateGateInput(input.input),
      policy = validateGatePolicy(input.policy ?? this.policy().policy),
      profile = provider(input.provider);
    return this.transaction(() => {
      const prior = this.forTurn(owned.sessionId, owned.rootTurnId);
      if (prior) {
        const original = JSON.parse(
          String(
            this.database()
              .prepare(
                "SELECT payload FROM request_generations WHERE request_id=? AND input_revision=1",
              )
              .get(prior.id)!.payload,
          ),
        );
        if (
          original.inputHash !== gateDigest(accepted) ||
          original.policyDigest !==
            gateDigest(input.policy ?? original.policy) ||
          gateDigest(original.provider) !== gateDigest(profile) ||
          gateDigest({
            ...prior.owner,
            remote: prior.owner.remote
              ? {
                  origin: prior.owner.remote.origin,
                  taskId: prior.owner.remote.taskId,
                }
              : null,
          }) !==
            gateDigest({
              ...owned,
              remote: owned.remote
                ? { origin: owned.remote.origin, taskId: owned.remote.taskId }
                : null,
            })
        )
          conflict(
            "This request intent already belongs to different input or policy.",
          );
        return prior;
      }
      const at = iso();
      const request: WorkerRequest = {
        schemaVersion: 1,
        id: randomUUID(),
        owner: owned,
        revision: 0,
        inputRevision: 1,
        input: accepted,
        inputHash: gateDigest(accepted),
        policy,
        policyDigest: gateDigest(policy),
        provider: profile,
        phase: "readiness",
        assignee: "operator",
        createdAt: at,
        updatedAt: at,
        reworkCount: 0,
        evaluations: [],
        findings: [],
        candidates: [],
        reviews: [],
        execution: null,
        attestation: null,
      };
      this.database()
        .prepare(
          "INSERT INTO worker_requests(id,session_id,root_turn_id,phase,payload) VALUES(?,?,?,?,?)",
        )
        .run(
          request.id,
          owned.sessionId,
          owned.rootTurnId,
          request.phase,
          "{}",
        );
      this.generation(request);
      this.save(request, "accepted");
      return clone(request);
    });
  }
  bindTurn(id: string, turnId: string, inputRevision?: number) {
    identifier(turnId, "turn ID");
    return this.transaction(() => {
      const request = this.get(id),
        revision = inputRevision ?? request.inputRevision;
      if (revision !== request.inputRevision)
        conflict("The accepted request input changed.");
      const existing = this.database()
        .prepare(
          "SELECT request_id,input_revision FROM request_turns WHERE session_id=? AND turn_id=?",
        )
        .get(request.owner.sessionId, turnId);
      if (existing) {
        if (
          existing.request_id !== id ||
          Number(existing.input_revision) !== revision
        )
          conflict("This turn already belongs to another request generation.");
        return request;
      }
      this.database()
        .prepare(
          "INSERT INTO request_turns(session_id,turn_id,request_id,input_revision) VALUES(?,?,?,?)",
        )
        .run(request.owner.sessionId, turnId, id, revision);
      this.save(request, "turn_bound", { turnId });
      return request;
    });
  }
  private facts(request: WorkerRequest): GateFactSnapshot {
    const output =
      request.execution?.inputRevision === request.inputRevision
        ? request.execution
        : null;
    return {
      ...output?.facts,
      ...inputGateFacts(request.input),
      "execution.outcome":
        output?.result?.type === "completed"
          ? "completed"
          : (output?.outcome ?? null),
      "execution.recoverySafe": !request.recoveryHold,
      "pending.count": output?.result?.type === "needs_input" ? 1 : 0,
      "findings.blockingCount": request.findings.filter(
        (f) =>
          f.source !== "deterministic" &&
          f.status === "open" &&
          f.blocking &&
          request.evaluations.some(
            (e) =>
              e.id === f.evaluationId &&
              e.inputRevision === request.inputRevision,
          ),
      ).length,
      "operator.accepted":
        !!request.attestation &&
        request.attestation.inputHash === request.inputHash &&
        request.attestation.outputDigest === output?.outputDigest,
    };
  }
  private evaluateInside(
    request: WorkerRequest,
    stage: GateStage,
  ): GateEvaluation {
    if (!["ready", "done"].includes(stage))
      invalid("Gate stage must be ready or done.");
    const facts = this.facts(request),
      verdict = evaluateGate(request.policy, stage, request.input.kind, facts),
      outputDigest =
        stage === "done" ? (request.execution?.outputDigest ?? null) : null;
    if (stage === "ready" && request.recoveryHold) {
      verdict.rules.push({
        ruleId: "worker-checkpoint-ownership",
        fact: "execution.recoverySafe",
        expected: true,
        observed: false,
        result: "fail",
      });
      verdict.passed = false;
    }
    const previous = request.evaluations.findLast(
      (e) => e.stage === stage && e.inputRevision === request.inputRevision,
    );
    if (
      previous &&
      gateDigest(previous.facts) === gateDigest(facts) &&
      previous.outputDigest === outputDigest &&
      previous.passed === verdict.passed &&
      gateDigest(previous.rules) === gateDigest(verdict.rules)
    ) {
      if (
        stage === "ready" &&
        previous.passed &&
        !request.recoveryHold &&
        request.execution?.result?.type !== "completed" &&
        [
          "failed",
          "cancelled",
          "interrupted",
          "waiting_input",
          "escalated",
        ].includes(request.phase)
      ) {
        request.phase = "ready";
        this.save(request, "readiness_reconfirmed", {
          evaluationId: previous.id,
        });
      }
      return previous;
    }
    if (request.evaluations.length >= 256)
      conflict("Evaluation history is full. Create a linked request.");
    const evaluation: GateEvaluation = {
      id: randomUUID(),
      stage,
      inputRevision: request.inputRevision,
      inputHash: request.inputHash,
      policyDigest: request.policyDigest,
      outputDigest,
      at: iso(),
      ...verdict,
      facts,
    };
    request.evaluations.push(evaluation);
    // Only this stage's superseded deterministic violations close automatically.
    for (const finding of request.findings)
      if (
        finding.source === "deterministic" &&
        finding.status === "open" &&
        request.evaluations.some(
          (e) => e.id === finding.evaluationId && e.stage === stage,
        )
      )
        finding.status = "resolved";
    for (const rule of verdict.rules.filter((rule) => rule.result !== "pass"))
      request.findings.push({
        id: randomUUID(),
        kind: rule.result === "unknown" ? "gap" : "issue",
        message: rule.ruleId === "worker-required-verification"
          ? "Required feature checks have not all passed for the captured worktree candidate. Repair and verify the retained changes before review."
          : `${rule.ruleId}: ${rule.fact} ${rule.result === "unknown" ? "is not observed" : "does not satisfy the configured rule"}.`,
        blocking: true,
        source: "deterministic",
        evaluationId: evaluation.id,
        ruleId: rule.ruleId,
        status: "open",
      });
    request.phase = verdict.passed
      ? stage === "ready"
        ? "ready"
        : "done"
      : stage === "done" &&
          verdict.rules
            .filter((r) => r.result !== "pass")
            .every((r) => r.fact === "operator.accepted")
        ? "review"
        : "needs_rework";
    if (verdict.passed) {
      for (const review of request.reviews)
        if (
          review.status === "queued" &&
          review.stage === stage &&
          review.inputHash === request.inputHash
        ) {
          review.status = "failed";
          review.errorCode = "superseded";
          review.finishedAt = iso();
        }
    }
    if (!verdict.passed && request.policy.reviewer.enabled)
      this.reserveInside(request, stage, evaluation, "review");
    this.save(request, verdict.passed ? "gate_passed" : "gate_held", {
      evaluationId: evaluation.id,
    });
    return evaluation;
  }
  evaluate(id: string, stage: GateStage) {
    return this.transaction(() => {
      const request = this.get(id);
      if (request.execution?.status === "running")
        conflict("Wait for execution before evaluating another gate.");
      if (stage === "ready" && request.execution?.result?.type === "completed")
        conflict("Completion must be evaluated before explicit rework.");
      return clone(this.evaluateInside(request, stage));
    });
  }
  holdRecovery(id: string, reason = "checkpoint_ownership") {
    if (!/^[a-z_]{1,80}$/.test(reason))
      invalid("Use a safe recovery reason code.");
    return this.transaction(() => {
      const request = this.get(id);
      request.recoveryHold ??= { code: reason, at: iso() };
      this.evaluateInside(request, "ready");
      return request;
    });
  }
  private assertReady(request: WorkerRequest) {
    if (request.recoveryHold)
      conflict(
        "The retained execution belongs to a different checkpoint. Create an explicit successor request.",
      );
    const evaluation = request.evaluations.findLast(
      (e) => e.stage === "ready" && e.inputRevision === request.inputRevision,
    );
    if (
      !evaluation?.passed ||
      evaluation.inputHash !== request.inputHash ||
      evaluation.policyDigest !== request.policyDigest
    )
      conflict("Readiness gate has not passed for this request generation.");
    if (["needs_rework", "review", "cancelled", "done"].includes(request.phase))
      conflict(
        "This request requires explicit rework before another execution.",
      );
  }
  prepareExecution(id: string, turnId: string, runId: string) {
    identifier(turnId, "turn ID");
    identifier(runId, "run ID");
    return this.transaction(() => {
      const request = this.get(id);
      this.assertReady(request);
      const bound = this.database()
        .prepare(
          "SELECT request_id,input_revision FROM request_turns WHERE session_id=? AND turn_id=?",
        )
        .get(request.owner.sessionId, turnId);
      if (
        bound?.request_id !== id ||
        Number(bound.input_revision) !== request.inputRevision
      )
        conflict("Bind the turn to this request generation before execution.");
      if (request.execution?.turnId === turnId) {
        if (request.execution.runId !== runId)
          conflict("The execution run is immutable.");
        return request;
      }
      if (
        request.execution &&
        ["prepared", "running"].includes(request.execution.status)
      )
        conflict("This request already has an admitted execution.");
      request.execution = {
        turnId,
        runId,
        inputRevision: request.inputRevision,
        status: "prepared",
        outcome: null,
        result: null,
        outputDigest: null,
        facts: {},
      };
      this.save(request, "execution_prepared", { turnId, runId });
      return request;
    });
  }
  startExecution(id: string, turnId: string, runId: string) {
    return this.transaction(() => {
      const request = this.get(id);
      this.assertReady(request);
      const execution = request.execution;
      if (
        !execution ||
        execution.turnId !== turnId ||
        execution.runId !== runId ||
        execution.inputRevision !== request.inputRevision ||
        !["prepared", "running"].includes(execution.status)
      )
        conflict("Execution does not match its durable intent.");
      if (execution.status === "running") return request;
      execution.status = "running";
      request.phase = "running";
      this.save(request, "execution_started", { turnId, runId });
      return request;
    });
  }
  recordResult(
    id: string,
    turnId: string,
    runId: string,
    result: ModelResult,
    facts: GateFactSnapshot = {},
  ) {
    if (
      !result ||
      !["completed", "needs_input"].includes(result.type) ||
      (result.type === "completed" &&
        (typeof result.text !== "string" || result.text.length > 1048576)) ||
      (result.type === "needs_input" &&
        (!result.request ||
          !["question", "escalation"].includes(result.request.kind) ||
          typeof result.request.message !== "string"))
    )
      invalid("Invalid known execution result.");
    const acceptedFacts = validateGateFacts(facts);
    if (Object.keys(acceptedFacts).some((key) => !key.startsWith("output.")))
      invalid(
        "Execution can only supply output facts; approvals and test claims require independent evidence.",
      );
    return this.transaction(() => {
      const request = this.get(id),
        execution = request.execution;
      if (
        !execution ||
        execution.turnId !== turnId ||
        execution.runId !== runId ||
        execution.inputRevision !== request.inputRevision
      )
        conflict("Known result does not match the current execution intent.");
      const outputDigest = gateDigest({ result, facts: acceptedFacts });
      if (execution.result) {
        if (execution.outputDigest !== outputDigest)
          conflict("A known execution result is immutable.");
        return request;
      }
      execution.result = clone(result);
      execution.outputDigest = outputDigest;
      execution.status = "completed";
      execution.outcome =
        result.type === "completed"
          ? request.input.kind === "patch"
            ? "review"
            : "completed"
          : result.request.kind === "question"
            ? "waiting_input"
            : "escalated";
      execution.facts = {
        ...acceptedFacts,
        "output.nonEmpty": result.type === "completed" && !!result.text.trim(),
        "output.protocolValid":
          result.type === "completed" &&
          (request.input.kind === "chat" ||
            acceptedFacts["output.protocolValid"] === true),
      };
      if (result.type === "needs_input") {
        request.phase =
          result.request.kind === "question" ? "waiting_input" : "escalated";
        this.save(request, "input_requested", { turnId, runId });
      } else {
        this.save(request, "result_recorded", { turnId, runId });
        this.evaluateInside(request, "done");
      }
      return request;
    });
  }
  failExecution(
    id: string,
    turnId: string,
    status: "failed" | "cancelled" | "interrupted",
  ) {
    if (!["failed", "cancelled", "interrupted"].includes(status))
      invalid("Invalid execution failure state.");
    return this.transaction(() => {
      const request = this.get(id),
        execution = request.execution;
      if (!execution || execution.turnId !== turnId)
        conflict("Execution failure does not match this request.");
      if (execution.result || execution.status === status) return request;
      execution.status = status;
      execution.outcome = status;
      request.phase = status;
      this.save(request, "execution_" + status, {
        turnId,
        runId: execution.runId,
      });
      return request;
    });
  }
  private reserveInside(
    request: WorkerRequest,
    stage: GateStage,
    evaluation: GateEvaluation,
    kind: "review" | "rework",
  ): GateReviewIntent {
    if (kind === "review") {
      const existing = request.reviews.find(
        (review) =>
          review.kind === kind &&
          review.inputHash === request.inputHash &&
          review.policyDigest === request.policyDigest &&
          review.stage === stage,
      );
      if (existing) return existing;
    } else if (
      request.reviews.filter((review) => review.kind === "rework").length >=
      request.policy.rework.maxAttempts
    )
      conflict("The explicit model rework budget is exhausted.");
    const intent: GateReviewIntent = {
      id: randomUUID(),
      requestId: request.id,
      kind,
      evaluationId: evaluation.id,
      stage,
      inputHash: request.inputHash,
      policyDigest: request.policyDigest,
      status: "queued",
      provider: {
        ...request.provider,
        id:
          request.policy.reviewer.provider === "same"
            ? request.provider.id
            : request.policy.reviewer.provider,
      },
      runId: null,
      dispatch: null,
      result: null,
      usage: null,
      errorCode: null,
      createdAt: iso(),
      finishedAt: null,
    };
    request.reviews.push(intent);
    return intent;
  }
  reserveReview(id: string, stage: GateStage): GateReviewIntent {
    return this.transaction(() => {
      const request = this.get(id),
        evaluation = request.evaluations.findLast(
          (e) => e.stage === stage && e.inputRevision === request.inputRevision,
        );
      if (!evaluation || evaluation.passed)
        conflict("Review requires a failed current gate evaluation.");
      const count = request.reviews.length,
        intent = this.reserveInside(request, stage, evaluation, "review");
      if (request.reviews.length !== count)
        this.save(request, "review_queued", { evaluationId: evaluation.id });
      return clone(intent);
    });
  }
  queuedReviews(limit = 20): GateReviewIntent[] {
    limit = boundedInteger(limit, 20, 1, 100);
    const intents: GateReviewIntent[] = [];
    for (const row of this.database()
      .prepare("SELECT payload FROM worker_requests ORDER BY sequence")
      .iterate()) {
      const request = JSON.parse(String(row.payload)) as WorkerRequest;
      for (const intent of request.reviews)
        if (
          intent.status === "queued" &&
          intent.inputHash === request.inputHash &&
          intent.policyDigest === request.policyDigest &&
          ["needs_rework", "review"].includes(request.phase)
        )
          intents.push(clone(intent));
      if (intents.length >= limit) break;
    }
    return intents.slice(0, limit);
  }
  startReview(
    id: string,
    intentId: string,
    runId: string,
    dispatch: ModelRequest,
  ): GateReviewIntent {
    identifier(runId, "review run ID");
    if (
      !dispatch ||
      dispatch.schemaVersion !== 1 ||
      Buffer.byteLength(JSON.stringify(dispatch)) > 2097152
    )
      invalid("A bounded frozen reviewer dispatch is required.");
    return this.transaction(() => {
      const request = this.get(id),
        intent = request.reviews.find((r) => r.id === intentId);
      if (
        !intent ||
        intent.status !== "queued" ||
        intent.inputHash !== request.inputHash ||
        intent.policyDigest !== request.policyDigest ||
        !["needs_rework", "review"].includes(request.phase)
      )
        conflict("This review intent is no longer executable.");
      if (
        dispatch.provider.id !== intent.provider.id ||
        dispatch.provider.model !== intent.provider.model
      )
        conflict("Reviewer dispatch changed its frozen provider or model.");
      intent.status = "running";
      intent.runId = runId;
      intent.dispatch = clone(dispatch);
      this.save(request, "review_started", {
        evaluationId: intent.evaluationId,
        runId,
      });
      return clone(intent);
    });
  }
  observeReviewUsage(id: string, intentId: string, usage: ProviderUsage) {
    return this.transaction(() => {
      const request = this.get(id),
        intent = request.reviews.find((r) => r.id === intentId);
      // A CLI can report its final counters while reacting to an abort. The request
      // cancellation is already durable, but that final observation still belongs
      // to the admitted invocation and must not look like a storage failure.
      const cancelledInvocation =
        intent?.status === "interrupted" &&
        intent.errorCode === "operator_cancelled" &&
        !!intent.runId &&
        !!intent.dispatch;
      if (!intent || (intent.status !== "running" && !cancelledInvocation))
        conflict("Usage does not belong to an admitted reviewer invocation.");
      const accepted = normalizeUsage(usage);
      if (gateDigest(intent.usage) === gateDigest(accepted)) return;
      intent.usage = accepted;
      this.save(request, "review_usage_observed", {
        evaluationId: intent.evaluationId,
        ...(intent.runId ? { runId: intent.runId } : {}),
      });
    });
  }
  private candidate(
    request: WorkerRequest,
    input: GateInput,
    source: "operator" | "reviewer",
  ): RequestCandidate {
    const accepted = validateGateInput(input);
    // Rework changes intent text, not the previously approved repository/files or execution kind.
    if (
      accepted.kind !== request.input.kind ||
      gateDigest(accepted.files ?? []) !==
        gateDigest(request.input.files ?? []) ||
      gateDigest(accepted.context ?? null) !==
        gateDigest(request.input.context ?? null)
    )
      conflict(
        "Rework cannot change the approved file scope or replay context. Create a new request to approve a different scope.",
      );
    const inputHash = gateDigest(accepted),
      duplicate = request.candidates.find(
        (c) =>
          c.basedOnInputRevision === request.inputRevision &&
          c.inputHash === inputHash,
      );
    if (duplicate) return duplicate;
    if (request.candidates.length >= 32)
      conflict("Candidate history is full. Create a linked request.");
    const candidate: RequestCandidate = {
      id: randomUUID(),
      basedOnInputRevision: request.inputRevision,
      input: accepted,
      inputHash,
      source,
      createdAt: iso(),
      status: "pending",
    };
    request.candidates.push(candidate);
    return candidate;
  }
  completeReview(
    id: string,
    intentId: string,
    result: NonNullable<GateReviewIntent["result"]>,
    usage: ProviderUsage,
  ): WorkerRequest {
    if (
      !result ||
      Object.keys(result).some(
        (key) => !["summary", "findings", "candidate"].includes(key),
      ) ||
      typeof result.summary !== "string" ||
      result.summary.length > 4000 ||
      !Array.isArray(result.findings) ||
      result.findings.length > 32 ||
      result.findings.some(
        (f) =>
          !f ||
          Object.keys(f).some(
            (key) => !["kind", "message", "blocking"].includes(key),
          ) ||
          !["question", "issue", "gap"].includes(f.kind) ||
          typeof f.message !== "string" ||
          !f.message.trim() ||
          f.message.length > 4000 ||
          (f.blocking !== undefined && typeof f.blocking !== "boolean"),
      )
    )
      invalid("Invalid bounded advisory reviewer result.");
    return this.transaction(() => {
      const request = this.get(id),
        intent = request.reviews.find((r) => r.id === intentId);
      if (!intent) conflict("Review intent not found.");
      if (intent.result) {
        if (gateDigest(intent.result) !== gateDigest(result))
          conflict("Reviewer result is immutable.");
        return request;
      }
      if (!["running", "interrupted"].includes(intent.status))
        conflict("Review has not started.");
      const currentEvaluation = request.evaluations.findLast(
        (e) =>
          e.stage === intent.stage && e.inputRevision === request.inputRevision,
      );
      const current =
        currentEvaluation?.id === intent.evaluationId &&
        !currentEvaluation.passed &&
        request.phase !== "cancelled" &&
        intent.errorCode !== "operator_cancelled" &&
        intent.inputHash === request.inputHash &&
        intent.policyDigest === request.policyDigest;
      if (result.candidate && current)
        this.candidate(request, result.candidate, "reviewer");
      intent.result = clone(result);
      intent.usage = normalizeUsage(usage);
      intent.status = "completed";
      intent.finishedAt = iso();
      intent.errorCode = null;
      if (current)
        for (const finding of result.findings)
          request.findings.push({
            id: randomUUID(),
            kind: finding.kind,
            message: finding.message,
            blocking: finding.blocking ?? false,
            source: "reviewer",
            evaluationId: intent.evaluationId,
            status: "open",
          });
      // Advisory text is never a gate pass or an operator attestation.
      this.save(request, "review_completed", {
        evaluationId: intent.evaluationId,
        ...(intent.runId ? { runId: intent.runId } : {}),
      });
      return request;
    });
  }
  failReview(
    id: string,
    intentId: string,
    code: string,
    usage?: ProviderUsage,
  ) {
    if (!/^[a-z_]{1,80}$/.test(code))
      invalid("Use a safe reviewer error code.");
    return this.transaction(() => {
      const request = this.get(id),
        intent = request.reviews.find((r) => r.id === intentId);
      if (!intent) conflict("Review intent not found.");
      if (intent.result || ["failed", "interrupted"].includes(intent.status))
        return request;
      intent.status = ["worker_restarted", "interrupted", "cancelled"].includes(
        code,
      )
        ? "interrupted"
        : "failed";
      intent.errorCode = code;
      intent.finishedAt = iso();
      if (usage) intent.usage = normalizeUsage(usage);
      this.save(request, "review_failed", {
        evaluationId: intent.evaluationId,
        ...(intent.runId ? { runId: intent.runId } : {}),
      });
      return request;
    });
  }
  command(input: RequestCommand): {
    request: WorkerRequest;
    duplicate: boolean;
  } {
    const fields: Record<string, string[]> = {
      execute: [],
      evaluate: ["stage"],
      assign: ["assignee"],
      attest: ["note", "inputHash", "outputDigest"],
      resolve_finding: ["findingId", "note"],
      propose: ["input"],
      accept_candidate: ["candidateId"],
      rework: ["stage", "note"],
      cancel: ["note"],
    };
    if (
      !input ||
      !fields[input.action] ||
      Object.keys(input).some(
        (key) =>
          ![
            "action",
            "requestId",
            "expectedRevision",
            "operationId",
            ...fields[input.action],
          ].includes(key),
      )
    )
      invalid("Use only the documented request command fields.");
    identifier(input.requestId, "request ID");
    identifier(input.operationId, "operation ID");
    boundedInteger(input.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER);
    if (
      input.note !== undefined &&
      (typeof input.note !== "string" || input.note.length > 8000)
    )
      invalid("Request note must be a bounded string.");
    const normalized = {
        ...input,
        ...(input.note !== undefined ? { note: input.note.trim() } : {}),
      },
      digest = gateDigest(normalized);
    return this.transaction(() => {
      const request = this.get(input.requestId);
      const previous = this.database()
        .prepare(
          "SELECT digest FROM request_operations WHERE request_id=? AND operation_id=?",
        )
        .get(request.id, input.operationId);
      if (previous) {
        if (previous.digest !== digest)
          conflict("This operation ID already belongs to different input.");
        return { request, duplicate: true };
      }
      if (request.revision !== input.expectedRevision)
        conflict("The request changed. Refresh before continuing.");
      if (
        request.execution &&
        ["prepared", "running"].includes(request.execution.status)
      )
        conflict(
          "Stop or finish the active attempt before changing its request.",
        );
      const stage =
        input.action === "execute"
          ? "ready"
          : (input.stage ??
            (request.execution?.result?.type === "completed"
              ? "done"
              : "ready"));
      if (input.action === "evaluate" || input.action === "execute") {
        if (
          stage === "ready" &&
          request.execution?.result?.type === "completed"
        )
          conflict(
            "Evaluate completion or explicitly accept rework before another execution.",
          );
        this.evaluateInside(request, stage);
      } else if (input.action === "assign") {
        if (!["operator", "llm"].includes(String(input.assignee)))
          invalid("Assignee must be operator or llm.");
        request.assignee = input.assignee!;
        this.save(request, "assigned");
      } else if (input.action === "attest") {
        if (
          !request.execution?.result ||
          request.execution.result.type !== "completed" ||
          input.inputHash !== request.inputHash ||
          input.outputDigest !== request.execution.outputDigest ||
          !normalized.note
        )
          conflict(
            "Operator acceptance must identify the current input and known output, with a note.",
          );
        request.attestation = {
          actor: "operator",
          inputHash: request.inputHash,
          outputDigest: request.execution.outputDigest!,
          note: normalized.note,
          at: iso(),
        };
        this.save(request, "operator_attested");
        this.evaluateInside(request, "done");
      } else if (input.action === "resolve_finding") {
        const finding = request.findings.find((f) => f.id === input.findingId);
        if (!finding || finding.source === "deterministic" || !normalized.note)
          conflict(
            "Deterministic failures require changed evidence; advisory resolution requires a note.",
          );
        finding.status = "resolved";
        finding.resolution = {
          actor: "operator",
          note: normalized.note,
          at: iso(),
        };
        this.save(request, "finding_resolved");
      } else if (input.action === "propose") {
        this.candidate(request, input.input!, "operator");
        this.save(request, "candidate_proposed");
      } else if (input.action === "accept_candidate") {
        if (request.owner.remote)
          conflict(
            "Remote input changes require an explicit successor request in the owning orchestrator.",
          );
        const candidate = request.candidates.find(
          (c) => c.id === input.candidateId,
        );
        if (
          !candidate ||
          candidate.status !== "pending" ||
          candidate.basedOnInputRevision !== request.inputRevision ||
          request.reworkCount >= request.policy.rework.maxAttempts
        )
          conflict("This candidate is stale or the rework limit is exhausted.");
        for (const item of request.candidates)
          if (item.status === "pending")
            item.status = item.id === candidate.id ? "accepted" : "superseded";
        for (const review of request.reviews)
          if (review.status === "queued") {
            review.status = "failed";
            review.errorCode = "superseded";
            review.finishedAt = iso();
          }
        request.input = clone(candidate.input);
        request.inputHash = candidate.inputHash;
        request.inputRevision++;
        request.reworkCount++;
        request.execution = null;
        request.attestation = null;
        request.recoveryHold = null;
        request.phase = "readiness";
        this.generation(request);
        this.save(request, "candidate_accepted");
        this.evaluateInside(request, "ready");
      } else if (input.action === "rework") {
        const evaluation = request.evaluations.findLast(
          (e) => e.stage === stage && e.inputRevision === request.inputRevision,
        );
        if (
          !evaluation ||
          evaluation.passed ||
          !["needs_rework", "review"].includes(request.phase)
        )
          conflict("Model rework requires a held current gate.");
        if (
          request.reviews.some(
            (r) =>
              r.inputHash === request.inputHash &&
              ["queued", "running"].includes(r.status),
          )
        )
          conflict("A review or rework is already pending for this input.");
        this.reserveInside(request, stage, evaluation, "rework");
        request.assignee = "llm";
        this.save(request, "rework_queued", { evaluationId: evaluation.id });
      } else if (input.action === "cancel") {
        request.phase = "cancelled";
        for (const review of request.reviews)
          if (["queued", "running"].includes(review.status)) {
            review.status = "interrupted";
            review.errorCode = "operator_cancelled";
            review.finishedAt = iso();
          }
        this.save(request, "cancelled");
      }
      this.database()
        .prepare(
          "INSERT INTO request_operations(request_id,operation_id,digest) VALUES(?,?,?)",
        )
        .run(request.id, input.operationId, digest);
      return { request: clone(request), duplicate: false };
    });
  }
  policy() {
    const row = this.database()
      .prepare("SELECT revision,payload FROM request_policy WHERE singleton=1")
      .get();
    const policy = row ? JSON.parse(String(row.payload)) : defaultGatePolicy();
    return {
      schemaVersion: 1 as const,
      revision: Number(row?.revision ?? 0),
      policy,
      digest: gateDigest(policy),
    };
  }
  setPolicy(input: {
    policy: unknown;
    expectedRevision: number;
    operationId: string;
  }) {
    if (
      !input ||
      Object.keys(input).some(
        (key) => !["policy", "expectedRevision", "operationId"].includes(key),
      )
    )
      invalid("Invalid policy command fields.");
    const policy = validateGatePolicy(input.policy);
    identifier(input.operationId, "operation ID");
    boundedInteger(input.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER);
    const digest = gateDigest({ ...input, policy });
    return this.transaction(() => {
      const previous = this.database()
        .prepare(
          "SELECT digest FROM request_policy_operations WHERE operation_id=?",
        )
        .get(input.operationId);
      if (previous) {
        if (previous.digest !== digest)
          conflict(
            "This policy operation ID already belongs to different input.",
          );
        return { ...this.policy(), duplicate: true };
      }
      const current = this.policy();
      if (current.revision !== input.expectedRevision)
        conflict("The gate policy changed. Refresh before saving.");
      this.database()
        .prepare(
          "INSERT INTO request_policy(singleton,revision,payload) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",
        )
        .run(current.revision + 1, JSON.stringify(policy));
      this.database()
        .prepare(
          "INSERT INTO request_policy_operations(operation_id,digest) VALUES(?,?)",
        )
        .run(input.operationId, digest);
      return { ...this.policy(), duplicate: false };
    });
  }
  deleteSession(sessionId: string) {
    identifier(sessionId, "session ID");
    this.transaction(() => {
      const rows = this.database()
        .prepare("SELECT id FROM worker_requests WHERE session_id=?")
        .all(sessionId);
      for (const row of rows)
        for (const table of [
          "request_generations",
          "request_executions",
          "request_turns",
          "request_operations",
          "request_events",
        ])
          this.database()
            .prepare(`DELETE FROM ${table} WHERE request_id=?`)
            .run(row.id!);
      this.database()
        .prepare("DELETE FROM worker_requests WHERE session_id=?")
        .run(sessionId);
    });
  }
}
