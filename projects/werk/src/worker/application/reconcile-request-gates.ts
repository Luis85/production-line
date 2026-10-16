import type { Snapshot } from "../../shared/snapshots.js";
import type { Task } from "../../shared/contracts.js";
import type { RequestGateEvidence } from "../../shared/request-gate.js";
import type { RequestCatalog } from "./journal-ports.js";
import type { AttemptJournal, WorkerClient, WorkerIdentity } from "./ports.js";
/** Reconcile a newly passed Done gate with its previously released remote lease. */
export class RemoteGateReconciler {
  private readonly requests: RequestCatalog;
  private readonly journal: Pick<AttemptJournal, "read">;
  private readonly acknowledged = new Set<string>();
  private readonly verifyReview?: (snapshot: Snapshot) => Promise<void>;
  private after = 0;
  private nextAt = 0;
  constructor(
    requests: RequestCatalog,
    journal: Pick<AttemptJournal, "read">,
    verifyReview?: (snapshot: Snapshot) => Promise<void>,
  ) {
    this.requests = requests;
    this.journal = journal;
    this.verifyReview = verifyReview;
  }
  async tick(
    client: WorkerClient,
    identity: WorkerIdentity,
    now = Date.now(),
  ): Promise<{ failed: number }> {
    if (now < this.nextAt) return { failed: 0 };
    this.nextAt = now + 10000;
    const page = this.requests.list({
      phase: "done",
      limit: 100,
      after: this.after,
    });
    this.after = page.hasMore ? page.nextAfter : 0;
    let failed = 0;
    for (const summary of page.rows) {
      const request = this.requests.get(summary.id),
        remote = request.owner.remote;
      if (
        !remote ||
        remote.origin !== new URL(identity.url).origin ||
        !request.execution?.result ||
        request.execution.result.type !== "completed"
      )
        continue;
      const evaluation = request.evaluations.findLast(
        (item) =>
          item.stage === "done" &&
          item.inputRevision === request.inputRevision &&
          item.passed &&
          item.outputDigest === request.execution?.outputDigest,
      );
      if (!evaluation) continue;
      const key = request.id + ":" + evaluation.id;
      if (this.acknowledged.has(key)) continue;
      try {
        const after = await this.journal.read(
          request.execution.turnId,
          "after",
        );
        if (
          !after?.requestGate ||
          after.requestGate.status !== "blocked" ||
          after.requestGate.stage !== "done" ||
          after.workerId !== identity.id ||
          after.taskId !== remote.taskId ||
          !["simulated", "change-set"].includes(after.execution.outcome)
        )
          continue;
        if (
          after.requestGate.requestId !== request.id ||
          after.requestGate.inputDigest !== evaluation.inputHash ||
          after.requestGate.policyDigest !== evaluation.policyDigest
        )
          continue;
        if (after.execution.outcome === "change-set") {
          if (!after.review || !this.verifyReview)
            throw Error("Review verification unavailable");
          await this.verifyReview(after);
        }
        // Artifact checks are asynchronous; an operator may cancel or replace the accepted input while they run.
        const current = this.requests.get(request.id);
        const currentEvaluation = current.evaluations.findLast(
          (item) =>
            item.stage === "done" &&
            item.inputRevision === current.inputRevision,
        );
        if (
          current.phase !== "done" ||
          current.recoveryHold ||
          current.inputHash !== request.inputHash ||
          current.execution?.outputDigest !== request.execution.outputDigest ||
          current.execution?.turnId !== request.execution.turnId ||
          currentEvaluation?.id !== evaluation.id ||
          !currentEvaluation.passed
        )
          continue;
        if (!client.resolveHold) {
          failed++;
          continue;
        }
        const gate: RequestGateEvidence = {
          schemaVersion: 1,
          requestId: request.id,
          revision: current.revision,
          inputDigest: evaluation.inputHash,
          policyDigest: evaluation.policyDigest,
          evaluationId: evaluation.id,
          stage: "done",
          status: "passed",
          failedRules: 0,
          unknownRules: 0,
        };
        const task: Pick<Task, "id" | "lease" | "attempt"> = {
          id: after.taskId,
          lease: after.pairId,
          attempt: after.attempt,
        };
        await client.resolveHold(task, after.requestGate.evaluationId, gate);
        this.acknowledged.add(key);
        if (this.acknowledged.size > 1000)
          this.acknowledged.delete(this.acknowledged.values().next().value!);
      } catch {
        failed++;
      }
    }
    return { failed };
  }
}
