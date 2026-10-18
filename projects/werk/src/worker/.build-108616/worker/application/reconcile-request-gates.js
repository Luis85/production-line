                                                          
                                                      
                                                                        
                                                         
                                                                               
/** Reconcile a newly passed Done gate with its previously released remote lease. */
export class RemoteGateReconciler {
                   requests                ;
                   journal                              ;
                   acknowledged = new Set        ();
                   verifyReview                                        ;
          after = 0;
          nextAt = 0;
  constructor(
    requests                ,
    journal                              ,
    verifyReview                                        ,
  ) {
    this.requests = requests;
    this.journal = journal;
    this.verifyReview = verifyReview;
  }
  async tick(
    client                                   ,
    identity                ,
    now = Date.now(),
  )                              {
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
        const gate                      = {
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
        const task                                         = {
          id: after.taskId,
          lease: after.pairId,
          attempt: after.attempt,
        };
        await client.resolveHold(task, after.requestGate.evaluationId, gate);
        this.acknowledged.add(key);
        if (this.acknowledged.size > 1000)
          this.acknowledged.delete(this.acknowledged.values().next().value );
      } catch {
        failed++;
      }
    }
    return { failed };
  }
}
