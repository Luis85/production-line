import { randomUUID } from "node:crypto";
import type {
  ModelRequest
} from "../../../application/model-contract.js";
import {
  gateDigest,
  type GateReviewIntent,
  type GateStage,
  type WorkerRequest
} from "../../../application/request-gates.js";
import type { ProviderUsage } from "../../../application/run-evidence.js";
import type { RequestStore } from './store.js';
import { boundedInteger, clone, conflict, identifier, invalid, iso, normalizeUsage, requestCandidate, requestReserveInside } from './values.js';

export function requestReserveReview(store: RequestStore, id: string, stage: GateStage): GateReviewIntent {
  return store.transaction(() => {
    const request = store.get(id),
      evaluation = request.evaluations.findLast(
        (e) => e.stage === stage && e.inputRevision === request.inputRevision,
      );
    if (!evaluation || evaluation.passed)
      conflict("Review requires a failed current gate evaluation.");
    const count = request.reviews.length,
      intent = requestReserveInside(request, stage, evaluation, "review");
    if (request.reviews.length !== count)
      store.save(request, "review_queued", { evaluationId: evaluation.id });
    return clone(intent);
  });
}

export function requestQueuedReviews(store: RequestStore, limit = 20): GateReviewIntent[] {
  limit = boundedInteger(limit, 20, 1, 100);
  const intents: GateReviewIntent[] = [];
  for (const row of store.database()
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

export function requestStartReview(
  store: RequestStore,
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
  return store.transaction(() => {
    const request = store.get(id),
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
      dispatch.provider.model !== intent.provider.model ||
      (dispatch.provider.effort ?? 'default') !== (intent.provider.effort ?? 'default') ||
      dispatch.provider.authenticationMode !== intent.provider.authenticationMode
    )
      conflict("Reviewer dispatch changed its frozen provider, model, effort or authentication mode.");
    intent.status = "running";
    intent.runId = runId;
    intent.dispatch = clone(dispatch);
    store.save(request, "review_started", {
      evaluationId: intent.evaluationId,
      runId,
    });
    return clone(intent);
  });
}

export function requestObserveReviewUsage(store: RequestStore, id: string, intentId: string, usage: ProviderUsage) {
  return store.transaction(() => {
    const request = store.get(id),
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
    store.save(request, "review_usage_observed", {
      evaluationId: intent.evaluationId,
      ...(intent.runId ? { runId: intent.runId } : {}),
    });
  });
}

export function requestCompleteReview(
  store: RequestStore,
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
  return store.transaction(() => {
    const request = store.get(id),
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
      requestCandidate(request, result.candidate, "reviewer");
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
    store.save(request, "review_completed", {
      evaluationId: intent.evaluationId,
      ...(intent.runId ? { runId: intent.runId } : {}),
    });
    return request;
  });
}

export function requestFailReview(
  store: RequestStore,
  id: string,
  intentId: string,
  code: string,
  usage?: ProviderUsage,
) {
  if (!/^[a-z_]{1,80}$/.test(code))
    invalid("Use a safe reviewer error code.");
  return store.transaction(() => {
    const request = store.get(id),
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
    store.save(request, "review_failed", {
      evaluationId: intent.evaluationId,
      ...(intent.runId ? { runId: intent.runId } : {}),
    });
    return request;
  });
}
