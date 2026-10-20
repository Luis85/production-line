import { deliveryVerificationEligibility } from '../../../application/delivery-verification-eligibility.js';
import { validateDeliveryPolicySnapshot } from '../../../application/delivery-policy.js';
import type { DevelopmentScopeView } from '../../../application/development.js';
import type { DeliveryMetricObservation } from '../../../application/delivery-metrics-contracts.js';
import { requestReadiness, readinessFindings } from './readiness.js';
import { randomUUID } from "node:crypto";
import {
  evaluateGate,
  gateDigest,
  inputGateFacts,
  type GateEvaluation,
  type GateFactSnapshot,
  type GateStage,
  type WorkerRequest
} from "../../../application/request-gates.js";
import type { RequestStore } from './store.js';
import { clone, conflict, invalid, iso, requestReserveInside } from './values.js';

function requestFacts(request: WorkerRequest): GateFactSnapshot {
  const output =
    request.execution?.inputRevision === request.inputRevision
      ? request.execution
      : null;
  const run = request.delivery, candidate = run?.review?.candidate;
  const context = request.input.context as { implementation?: DevelopmentScopeView; deliveryPolicy?: unknown } | undefined;
  const currentPackage = candidate && run?.status === 'completed' && !run.control && !run.holds.length && candidate.runId === run.id && candidate.requestId === request.id && candidate.inputRevision === request.inputRevision && candidate.inputHash === request.inputHash && candidate.policyDigest === request.policyDigest;
  const evidence = currentPackage ? run.steps.findLast(step => step.phase === 'verifying' && step.purpose !== 'candidate_review' && step.evidence?.candidateDigest === candidate.candidateDigest)?.evidence : undefined;
  const exceptionPolicy = context?.deliveryPolicy ? validateDeliveryPolicySnapshot(context.deliveryPolicy).profile.exceptions : undefined;
  const eligible = !!currentPackage && context?.implementation?.mode === 'worktree' && Array.isArray(context.implementation.checks) && Array.isArray(context.implementation.approvedPaths) && deliveryVerificationEligibility(context.implementation, evidence, candidate, run?.criterionDecisions, exceptionPolicy).eligible;
  return {
    ...output?.facts,
    // Preserve immutable invocation facts. A subsequently packaged exact candidate has independent evidence.
    ...(eligible ? { 'output.verificationEligible': true, 'output.protocolValid': true, 'output.patchPresent': true, 'output.changedFileCount': evidence!.changedPaths.length } : {}),
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
  store: RequestStore,
  request: WorkerRequest,
  stage: GateStage,
): GateEvaluation {
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
  const readiness = stage === 'ready' ? requestReadiness(request) : undefined;
  if (readiness?.configured && !readiness.passed) verdict.passed = false;
  const previous = request.evaluations.findLast(
    (e) => e.stage === stage && e.inputRevision === request.inputRevision,
  );
  if (
    previous &&
    gateDigest(previous.facts) === gateDigest(facts) &&
    previous.outputDigest === outputDigest &&
    previous.passed === verdict.passed &&
    gateDigest(previous.readiness ?? null) === gateDigest(readiness?.configured ? readiness : null) &&
    gateDigest(previous.rules) === gateDigest(verdict.rules)
  ) {
    if (
      stage === "ready" &&
      previous.passed &&
      !request.recoveryHold &&
      request.execution?.result?.type !== "completed" &&
      [
        "failed",
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
    ...(readiness?.configured ? { readiness } : {}),
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
  const observations: DeliveryMetricObservation[] = [];
  for (const rule of verdict.rules.filter((rule) => rule.result !== "pass")) {
    const findingId = randomUUID();
    const alreadyObserved = request.evaluations.some(item => item.id !== evaluation.id && item.stage === 'ready' && item.inputRevision === request.inputRevision && item.rules.some(prior => prior.ruleId === rule.ruleId && prior.result === 'fail'));
    if (stage === 'ready' && rule.result === 'fail' && ['input.messageLength', 'input.criteriaCount'].includes(rule.fact) && !alreadyObserved)
      observations.push({ kind: 'clarification', answerTracking: true, questionId: findingId, cycleId: `input-${request.inputRevision}`, cause: rule.fact === 'input.criteriaCount' ? 'acceptance_criteria' : 'outcome_detail' });
    request.findings.push({
      id: findingId,
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
  }
  if (readiness?.configured) readinessFindings(request, evaluation.id, readiness);
  request.phase = verdict.passed
    ? stage === "ready"
      ? "ready"
      : request.delivery && facts['operator.accepted'] !== true ? 'review' : 'done'
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
    observations,
    evaluationId: evaluation.id,
  });
  return evaluation;
}

export function requestEvaluate(store: RequestStore, id: string, stage: GateStage) {
  return store.transaction(() => {
    const request = store.get(id);
    if (request.execution?.status === "running")
      conflict("Wait for execution before evaluating another gate.");
    if (stage === "ready" && request.execution?.result?.type === "completed")
      conflict("Completion must be evaluated before explicit rework.");
    return clone(requestEvaluateInside(store, request, stage));
  });
}

export function requestHoldRecovery(store: RequestStore, id: string, reason = "checkpoint_ownership") {
  if (!/^[a-z_]{1,80}$/.test(reason))
    invalid("Use a safe recovery reason code.");
  return store.transaction(() => {
    const request = store.get(id);
    request.recoveryHold ??= { code: reason, at: iso() };
    requestEvaluateInside(store, request, "ready");
    return request;
  });
}

export function requestAssertReady(request: WorkerRequest) {
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
  if (request.deliveryHolds?.length || request.delivery?.holds.length || request.delivery?.control || request.delivery && ['paused', 'interrupting', 'outcome_unknown', 'reconciling'].includes(request.delivery.status)) conflict('Resolve the delivery hold before another execution.');
  if (["needs_rework", "review", "cancelled", "done", "interrupted"].includes(request.phase))
    conflict(
      "This request requires explicit rework before another execution.",
    );
}
