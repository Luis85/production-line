import { requestClarificationAnswers } from './clarifications.js';
import { validateDeliveryPolicySnapshot } from '../../../application/delivery-policy.js';
import { humanReviewOutcomes, humanReviewObservations } from '../../../application/delivery-human-review.js';
import { requestReadinessDecision } from './readiness.js';
import { requestCriterionDecision } from './criterion-decisions.js';
import { remotePublicationCommands, remotePublicationPending } from '../../../application/remote-delivery-contracts.js';
import { requestPublicationCommand } from './publication.js';
import type { DeliveryStopObservation } from '../../../application/delivery-contracts.js';
import {
  defaultGatePolicy,
  gateDigest,
  validateGatePolicy,
  type RequestCommand,
  type WorkerRequest
} from "../../../application/request-gates.js";
import { assertDeliveryAcceptance, assertDeliverySubject } from '../../../application/delivery-review.js';
import { deliveryCommandActions, requestDeliveryCommand } from './delivery.js';
import { requestEvaluateInside } from './gates.js';
import type { RequestStore } from './store.js';
import { boundedInteger, clone, conflict, identifier, invalid, iso, requestCandidate, requestReserveInside } from './values.js';

export function requestReplayCommand(store: RequestStore, input: RequestCommand): { request: WorkerRequest; duplicate: true } | undefined {
  identifier(input.requestId, 'request ID'); identifier(input.operationId, 'operation ID');
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 8000)) invalid('Request note must be a bounded string.');
  const previous = store.database().prepare('SELECT digest FROM request_operations WHERE request_id=? AND operation_id=?').get(input.requestId, input.operationId);
  if (!previous) return;
  const digest = gateDigest({ ...input, ...(input.note !== undefined ? { note: input.note.trim() } : {}) });
  if (previous.digest !== digest) conflict('This operation ID already belongs to different input.');
  return { request: store.get(input.requestId), duplicate: true };
}

export function requestCommand(store: RequestStore, input: RequestCommand, stopped?: DeliveryStopObservation): {
  request: WorkerRequest;
  duplicate: boolean;
} {
  const fields: Record<string, string[]> = {
    readiness_decision: ['inputRevision', 'inputHash', 'assessmentId', 'proposalId', 'decision', 'note'],
    criterion_decision: ['deliveryRunId', 'inputRevision', 'candidateCommit', 'candidateDigest', 'criterionDecision'],
    execute: [],
    evaluate: ["stage"],
    assign: ["assignee"],
    attest: ['note', 'inputHash', 'outputDigest', 'candidateCommit', 'candidateDigest', 'inputRevision', 'humanOutcomes', 'reviewDurationMinutes'],
    request_changes: ['note', 'inputRevision', 'candidateCommit', 'candidateDigest', 'humanOutcomes', 'reviewDurationMinutes'],
    resolve_finding: ["findingId", "note"],
    propose: ["input"],
    accept_candidate: ["candidateId"],
    rework: ["stage", "note"],
    cancel: ['note', 'deliveryRunId', 'inputRevision'],
    pause_after_step: ['note', 'deliveryRunId', 'inputRevision'],
    interrupt: ['note', 'deliveryRunId', 'inputRevision'],
    resume: ['note', 'deliveryRunId', 'inputRevision'],
    retry: ['note', 'deliveryRunId', 'inputRevision'],
    reopen: ['note', 'deliveryRunId', 'inputRevision'],
    confirm_stopped: ['note', 'deliveryRunId', 'inputRevision'],
    push_candidate: ['deliveryRunId', 'inputRevision', 'candidateCommit', 'candidateDigest'],
    create_pull_request: ['deliveryRunId', 'inputRevision', 'candidateCommit', 'candidateDigest'],
    reconcile_publication: ['deliveryRunId', 'inputRevision', 'candidateCommit', 'candidateDigest', 'publicationOperationId'],
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
  return store.transaction(() => {
    const request = store.get(input.requestId);
    const previous = store.database()
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
    if (remotePublicationPending(request.delivery) && !['cancel', 'reconcile_publication'].includes(input.action)) conflict('Reconcile the saved remote publication before changing or continuing this request.');
    const deliveryControl = deliveryCommandActions.includes(input.action as typeof deliveryCommandActions[number]) || input.action === 'cancel' && !!request.delivery;
    if (
      !deliveryControl && request.execution &&
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
    if (remotePublicationCommands.includes(input.action as typeof remotePublicationCommands[number])) {
      requestPublicationCommand(store, request, normalized);
    } else if (input.action === 'readiness_decision') {
      requestReadinessDecision(store, request, normalized); requestEvaluateInside(store, request, 'ready');
    } else if (input.action === 'criterion_decision') {
      requestCriterionDecision(store, request, normalized);
    } else if (deliveryControl) {
      requestDeliveryCommand(store, request, normalized, stopped);
    } else if (input.action === "evaluate" || input.action === "execute") {
      if (
        stage === "ready" &&
        request.execution?.result?.type === "completed"
      )
        conflict(
          "Evaluate completion or explicitly accept rework before another execution.",
        );
      if (['cancelled', 'interrupted'].includes(request.phase)) conflict('Use an explicit reopen or resume control before reevaluating this request.');
      requestEvaluateInside(store, request, stage);
    } else if (input.action === "assign") {
      if (!["operator", "llm"].includes(String(input.assignee)))
        invalid("Assignee must be operator or llm.");
      request.assignee = input.assignee!;
      store.save(request, "assigned");
    } else if (input.action === "attest") {
      if (input.reviewDurationMinutes !== undefined && (typeof input.reviewDurationMinutes !== 'number' || !Number.isFinite(input.reviewDurationMinutes) || input.reviewDurationMinutes < 0 || input.reviewDurationMinutes > 1440)) invalid('Reported review effort must be between 0 and 1,440 minutes.');
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
      if (request.delivery && !request.delivery.review) conflict('Human acceptance requires the verified delivery review package.');
      if (request.delivery && request.phase !== 'review') conflict('Only the current review-ready candidate can be accepted. Restore verification after candidate changes.');
      if (request.delivery?.review) {
        const review = request.delivery.review;
        if (input.candidateCommit !== review.candidate.candidateCommit) conflict('Acceptance must identify the exact candidate commit.');
        const humanOutcomes = humanReviewOutcomes(input.humanOutcomes, review, iso());
        const context = request.input.context as { deliveryPolicy?: unknown } | undefined;
        const exceptionPolicy = context?.deliveryPolicy ? validateDeliveryPolicySnapshot(context.deliveryPolicy).profile.exceptions : undefined;
        assertDeliveryAcceptance(review, { inputRevision: input.inputRevision!, inputHash: request.inputHash, candidateCommit: input.candidateCommit!, candidateDigest: input.candidateDigest!, policyDigest: request.policyDigest, humanOutcomes, criterionDecisions: request.delivery.criterionDecisions, exceptionPolicy });
        request.delivery!.humanOutcomes = humanOutcomes;
      }
      request.attestation = {
        actor: "operator",
        inputHash: request.inputHash,
        outputDigest: request.execution.outputDigest!,
        note: normalized.note,
        at: iso(),
      };
      store.save(request, "operator_attested", { observations: humanReviewObservations(request.delivery?.humanOutcomes ?? [], input.candidateDigest ?? '', input.reviewDurationMinutes) });
      requestEvaluateInside(store, request, "done");
    } else if (input.action === 'request_changes') {
      const review = request.delivery?.review;
      if (!review || !normalized.note || request.phase !== 'review') conflict('Request changes requires the current review package and explanatory feedback.');
      if (input.candidateCommit !== review.candidate.candidateCommit) conflict('Changes must target the exact candidate commit.');
      assertDeliverySubject(review.candidate, { inputRevision: input.inputRevision!, inputHash: request.inputHash, candidateCommit: input.candidateCommit!, candidateDigest: input.candidateDigest!, policyDigest: request.policyDigest });
      const outcomes = input.humanOutcomes === undefined ? [] : humanReviewOutcomes(input.humanOutcomes, review, iso());
      const observations = humanReviewObservations(outcomes, review.candidate.candidateDigest, input.reviewDurationMinutes);
      if (input.humanOutcomes !== undefined) request.delivery!.humanOutcomes = outcomes;
      const hold = { code: 'review_changes', reason: normalized.note };
      request.deliveryHolds = [...(request.deliveryHolds ?? []).filter(item => item.code !== hold.code), hold];
      request.delivery!.holds = clone(request.deliveryHolds); request.delivery!.status = 'waiting'; request.phase = 'needs_rework';
      store.save(request, 'review_changes_requested', { observations });
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
      store.save(request, "finding_resolved", { observations: requestClarificationAnswers(store, request.id, finding.id) });
    } else if (input.action === "propose") {
      requestCandidate(request, input.input!, "operator");
      store.save(request, "candidate_proposed");
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
      store.generation(request);
      store.save(request, "candidate_accepted");
      requestEvaluateInside(store, request, "ready");
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
      requestReserveInside(request, stage, evaluation, "rework");
      request.assignee = "llm";
      store.save(request, "rework_queued", { evaluationId: evaluation.id });
    } else if (input.action === "cancel") {
      request.phase = "cancelled";
      for (const review of request.reviews)
        if (["queued", "running"].includes(review.status)) {
          review.status = "interrupted";
          review.errorCode = "operator_cancelled";
          review.finishedAt = iso();
        }
      store.save(request, "cancelled");
    }
    store.database()
      .prepare(
        "INSERT INTO request_operations(request_id,operation_id,digest) VALUES(?,?,?)",
      )
      .run(request.id, input.operationId, digest);
    return { request: clone(request), duplicate: false };
  });
}

export function requestPolicy(store: RequestStore) {
  const row = store.database()
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

export function requestSetPolicy(store: RequestStore, input: {
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
  return store.transaction(() => {
    const previous = store.database()
      .prepare(
        "SELECT digest FROM request_policy_operations WHERE operation_id=?",
      )
      .get(input.operationId);
    if (previous) {
      if (previous.digest !== digest)
        conflict(
          "This policy operation ID already belongs to different input.",
        );
      return { ...requestPolicy(store), duplicate: true };
    }
    const current = requestPolicy(store);
    if (current.revision !== input.expectedRevision)
      conflict("The gate policy changed. Refresh before saving.");
    store.database()
      .prepare(
        "INSERT INTO request_policy(singleton,revision,payload) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",
      )
      .run(current.revision + 1, JSON.stringify(policy));
    store.database()
      .prepare(
        "INSERT INTO request_policy_operations(operation_id,digest) VALUES(?,?)",
      )
      .run(input.operationId, digest);
    return { ...requestPolicy(store), duplicate: false };
  });
}
