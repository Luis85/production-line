import { canonicalValue } from "../intake/successor.js";
import {
  validateRequestGateEvidence,
  type RequestGateEvidence,
} from "../../shared/request-gate.js";
import { identifier } from "../../shared/contracts.js";
import type { Task } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import type { WorkerRecord } from "../../shared/protocol.js";
import type { StoreSession } from "./session.js";

/** Completion, retry and request-gate transitions with durable evidence. */
export class TaskLifecycleRepository {
  private readonly session: StoreSession;

  constructor(session: StoreSession) {
    this.session = session;
  }

  finish(w: WorkerRecord, id: string, lease: unknown, attempt: unknown): Task {
    return this.session.transaction(() => {
      const t = this.session.get(id);
      if (
        ["simulated", "review"].includes(t.status) &&
        t.workerId === w.id &&
        t.lease === lease &&
        t.attempt === attempt
      )
        return t;
      this.session.checkLease(t, w, lease, attempt);
      const pair = this.session.db
        .prepare(
          "SELECT phase,payload FROM snapshots WHERE task=? AND attempt=?",
        )
        .all(id, t.attempt) as any[];
      const live = t.executionMode === "cli";
      if (
        pair.length !== 2 ||
        !pair.some(
          (s) =>
            s.phase === "after" &&
            JSON.parse(s.payload).execution.outcome ===
              (live ? "change-set" : "simulated"),
        )
      )
        throw new DomainError(
          "conflict",
          "Before/after snapshots required before completion",
        );
      if (t.requestGate && (t.requestGate.stage !== "done" || t.requestGate.status !== "passed"))
        throw new DomainError("conflict", "Passed completion gate evidence is required before completion.");
      this.session.db
        .prepare("UPDATE tasks SET status=?,expires=NULL WHERE id=?")
        .run(live ? "review" : "simulated", id);
      this.session.event(id, live ? "review_ready" : "simulation_finished", {
        workerId: w.id,
        attempt,
        prCreated: false,
        ...(live ? { mergeAllowed: false } : {}),
      });
      return this.session.get(id);
    });
  }
  abandon(w: WorkerRecord, id: string, lease: unknown, attempt: unknown): Task {
    return this.session.transaction(() => {
      const t = this.session.get(id);
      const prior = this.session.db
        .prepare("SELECT worker,lease FROM attempts WHERE task=? AND attempt=?")
        .get(id, typeof attempt === "number" ? attempt : -1) as any;
      const alreadyAbandoned =
        prior?.worker === w.id &&
        prior?.lease === lease &&
        this.session.db
          .prepare(
            "SELECT 1 FROM events WHERE task=? AND kind='abandoned' AND json_extract(detail,'$.attempt')=?",
          )
          .get(id, typeof attempt === "number" ? attempt : -1);
      if (alreadyAbandoned) return t;
      this.session.checkLease(t, w, lease, attempt);
      const status =
        t.attempt >= this.session.attemptLimit(id, t.attempt) ? "blocked" : "queued";
      const after = this.session.db
        .prepare(
          "SELECT payload FROM snapshots WHERE task=? AND attempt=? AND phase='after'",
        )
        .get(id, t.attempt) as any;
      this.session.db
        .prepare(
          "UPDATE tasks SET status=?,worker=NULL,lease=NULL,expires=NULL,profile=NULL WHERE id=?",
        )
        .run(status, id);
      this.session.event(id, "abandoned", {
        workerId: w.id,
        attempt,
        status,
        outcome: after
          ? JSON.parse(after.payload).execution.outcome
          : "unavailable",
      });
      return this.session.get(id);
    });
  }
  hold(
    w: WorkerRecord,
    id: string,
    lease: unknown,
    attempt: unknown,
    value: RequestGateEvidence,
  ): Task {
    const gate = validateRequestGateEvidence(value);
    if (gate.status !== "blocked")
      throw new DomainError(
        "invalid_input",
        "Only a failed gate can hold a request.",
      );
    return this.session.transaction(() => {
      const task = this.session.get(id);
      const prior = this.session.db
        .prepare("SELECT worker,lease FROM attempts WHERE task=? AND attempt=?")
        .get(id, typeof attempt === "number" ? attempt : -1) as any;
      const held = this.session.db
        .prepare(
          "SELECT detail FROM events WHERE task=? AND kind='gate_held' AND json_extract(detail,'$.attempt')=?",
        )
        .get(id, typeof attempt === "number" ? attempt : -1) as any;
      if (prior?.worker === w.id && prior?.lease === lease && held) {
        if (
          canonicalValue(JSON.parse(held.detail).gate) !== canonicalValue(gate)
        )
          throw new DomainError(
            "conflict",
            "Gate hold receipt differs from the acknowledged receipt.",
          );
        return task;
      }
      this.session.checkLease(task, w, lease, attempt);
      const pair = this.session.db
        .prepare(
          "SELECT phase,payload FROM snapshots WHERE task=? AND attempt=?",
        )
        .all(id, task.attempt) as any[];
      const after = pair.find((row) => row.phase === "after");
      if (
        pair.length !== 2 ||
        !after ||
        canonicalValue(JSON.parse(after.payload).requestGate) !==
          canonicalValue(gate)
      )
        throw new DomainError(
          "conflict",
          "Matching paired gate evidence is required before holding a request.",
        );
      this.session.db
        .prepare(
          "UPDATE tasks SET status='blocked',worker=NULL,lease=NULL,expires=NULL,profile=NULL WHERE id=?",
        )
        .run(id);
      this.session.event(id, "gate_held", { workerId: w.id, attempt, gate });
      return this.session.get(id);
    });
  }
  resolveHold(
    w: WorkerRecord,
    id: string,
    lease: unknown,
    attempt: unknown,
    heldEvaluationId: string,
    value: RequestGateEvidence,
  ): Task {
    const gate = validateRequestGateEvidence(value);
    if (gate.status !== "passed" || gate.stage !== "done")
      throw new DomainError(
        "invalid_input",
        "Hold resolution requires a passed completion gate.",
      );
    identifier(heldEvaluationId, "heldEvaluationId");
    return this.session.transaction(() => {
      const task = this.session.get(id);
      const assignment = this.session.db
        .prepare("SELECT worker,lease FROM attempts WHERE task=? AND attempt=?")
        .get(id, typeof attempt === "number" ? attempt : -1) as any;
      if (
        task.project !== w.project ||
        assignment?.worker !== w.id ||
        assignment?.lease !== lease
      )
        throw new DomainError(
          "forbidden",
          "Hold resolution belongs to another worker assignment.",
        );
      const prior = this.session.db
        .prepare(
          "SELECT detail FROM events WHERE task=? AND kind='gate_released' AND json_extract(detail,'$.attempt')=?",
        )
        .get(id, attempt as number);
      if (prior) {
        const receipt = JSON.parse(String(prior.detail));
        const { revision: recordedRevision, ...recordedDecision } =
          receipt.gate;
        const { revision, ...decision } = gate;
        if (
          receipt.heldEvaluationId !== heldEvaluationId ||
          revision < recordedRevision ||
          canonicalValue(recordedDecision) !== canonicalValue(decision)
        )
          throw new DomainError(
            "conflict",
            "Hold resolution differs from its acknowledged receipt.",
          );
        return task;
      }
      const held = this.session.db
        .prepare(
          "SELECT detail FROM events WHERE task=? AND kind='gate_held' AND json_extract(detail,'$.attempt')=?",
        )
        .get(id, attempt as number);
      if (task.status !== "blocked" || task.attempt !== attempt || !held)
        throw new DomainError(
          "conflict",
          "Hold resolution requires the current blocked attempt.",
        );
      const previous = validateRequestGateEvidence(
        JSON.parse(String(held.detail)).gate,
      );
      if (
        previous.evaluationId !== heldEvaluationId ||
        previous.stage !== "done" ||
        gate.evaluationId === previous.evaluationId ||
        gate.revision <= previous.revision ||
        gate.requestId !== previous.requestId ||
        gate.inputDigest !== previous.inputDigest ||
        gate.policyDigest !== previous.policyDigest
      )
        throw new DomainError(
          "conflict",
          "Hold resolution must evaluate the same accepted input and policy after the held decision.",
        );
      if (
        this.session.db
          .prepare(
            "SELECT child FROM task_successors WHERE parent=? AND attempt=? AND evaluation=?",
          )
          .get(id, attempt as number, heldEvaluationId)
      )
        throw new DomainError(
          "conflict",
          "This held request already has a successor.",
        );
      const pair = this.session.db
        .prepare(
          "SELECT phase,payload FROM snapshots WHERE task=? AND attempt=?",
        )
        .all(id, attempt as number) as any[];
      const after = pair.find((row) => row.phase === "after");
      const outcome = task.executionMode === "cli" ? "change-set" : "simulated";
      if (
        pair.length !== 2 ||
        !after ||
        JSON.parse(after.payload).execution.outcome !== outcome ||
        canonicalValue(JSON.parse(after.payload).requestGate) !==
          canonicalValue(previous)
      )
        throw new DomainError(
          "conflict",
          "Hold resolution requires the original successful result and matching gate evidence.",
        );
      this.session.db
        .prepare("UPDATE tasks SET status=?,expires=NULL WHERE id=?")
        .run(task.executionMode === "cli" ? "review" : "simulated", id);
      this.session.event(id, "gate_released", {
        workerId: w.id,
        attempt,
        heldEvaluationId,
        gate,
      });
      return this.session.get(id);
    });
  }
}
