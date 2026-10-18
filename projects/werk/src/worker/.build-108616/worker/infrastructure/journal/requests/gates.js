import { randomUUID } from "node:crypto";
import {
  evaluateGate,
  gateDigest,
  inputGateFacts,
                      
                        
                 
                    
} from "../../../application/request-gates.js";
                                               
import { clone, conflict, invalid, iso, requestReserveInside } from './values.js';

function requestFacts(request               )                   {
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

export function requestEvaluateInside(
  store              ,
  request               ,
  stage           ,
)                 {
  if (!["ready", "done"].includes(stage))
    invalid("Gate stage must be ready or done.");
  const facts = requestFacts(request),
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
      store.save(request, "readiness_reconfirmed", {
        evaluationId: previous.id,
      });
    }
    return previous;
  }
  if (request.evaluations.length >= 256)
    conflict("Evaluation history is full. Create a linked request.");
  const evaluation                 = {
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
    requestReserveInside(request, stage, evaluation, "review");
  store.save(request, verdict.passed ? "gate_passed" : "gate_held", {
    evaluationId: evaluation.id,
  });
  return evaluation;
}

export function requestEvaluate(store              , id        , stage           ) {
  return store.transaction(() => {
    const request = store.get(id);
    if (request.execution?.status === "running")
      conflict("Wait for execution before evaluating another gate.");
    if (stage === "ready" && request.execution?.result?.type === "completed")
      conflict("Completion must be evaluated before explicit rework.");
    return clone(requestEvaluateInside(store, request, stage));
  });
}

export function requestHoldRecovery(store              , id        , reason = "checkpoint_ownership") {
  if (!/^[a-z_]{1,80}$/.test(reason))
    invalid("Use a safe recovery reason code.");
  return store.transaction(() => {
    const request = store.get(id);
    request.recoveryHold ??= { code: reason, at: iso() };
    requestEvaluateInside(store, request, "ready");
    return request;
  });
}

export function requestAssertReady(request               ) {
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
