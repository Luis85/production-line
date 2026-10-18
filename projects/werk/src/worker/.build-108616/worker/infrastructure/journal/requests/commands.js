import {
  defaultGatePolicy,
  gateDigest,
  validateGatePolicy,
                      
                    
} from "../../../application/request-gates.js";
import { requestEvaluateInside } from './gates.js';
                                               
import { boundedInteger, clone, conflict, identifier, invalid, iso, requestCandidate, requestReserveInside } from './values.js';

export function requestCommand(store              , input                )   
                         
                     
  {
  const fields                           = {
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
      requestEvaluateInside(store, request, stage);
    } else if (input.action === "assign") {
      if (!["operator", "llm"].includes(String(input.assignee)))
        invalid("Assignee must be operator or llm.");
      request.assignee = input.assignee ;
      store.save(request, "assigned");
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
        outputDigest: request.execution.outputDigest ,
        note: normalized.note,
        at: iso(),
      };
      store.save(request, "operator_attested");
      requestEvaluateInside(store, request, "done");
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
      store.save(request, "finding_resolved");
    } else if (input.action === "propose") {
      requestCandidate(request, input.input , "operator");
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

export function requestPolicy(store              ) {
  const row = store.database()
    .prepare("SELECT revision,payload FROM request_policy WHERE singleton=1")
    .get();
  const policy = row ? JSON.parse(String(row.payload)) : defaultGatePolicy();
  return {
    schemaVersion: 1         ,
    revision: Number(row?.revision ?? 0),
    policy,
    digest: gateDigest(policy),
  };
}

export function requestSetPolicy(store              , input   
                  
                           
                      
 ) {
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
