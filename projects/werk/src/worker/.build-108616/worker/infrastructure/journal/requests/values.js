import { randomUUID } from "node:crypto";
import { DomainError } from "../../../../shared/errors.js";
             
               
                                                
import {
  gateDigest,
  gateIdentifier,
  validateGateInput,
                      
                 
                        
                 
                        
                    
                      
                    
} from "../../../application/request-gates.js";
                                                                          
import { unknownUsage } from "../../../application/run-evidence.js";

export function normalizeUsage(value               )                {
  const normalized = unknownUsage();
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "providerReportedCostUsd",
  ]         ) {
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
  ].some((key) => (normalized       )[key] !== null)
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

export const clone =    (value   )    => structuredClone(value);

export function invalid(message        )        {
  throw new DomainError("invalid_input", message);
}

export function conflict(message        )        {
  throw new DomainError("conflict", message);
}

export const iso = () => new Date().toISOString();

export function identifier(value         , label        )         {
  if (!gateIdentifier(value)) invalid(`Invalid ${label}.`);
  return value          ;
}

export function boundedInteger(
  value         ,
  fallback        ,
  min        ,
  max        ,
)         {
  const chosen = value === undefined ? fallback : value;
  if (
    !Number.isSafeInteger(chosen) ||
    Number(chosen) < min ||
    Number(chosen) > max
  )
    invalid("Pagination requires bounded nonnegative integers.");
  return Number(chosen);
}

export function provider(value               )                {
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

export function owner(value              )               {
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
    let url     ;
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

export function summary(request               )                 {
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

export function requestReserveInside(
  request               ,
  stage           ,
  evaluation                ,
  kind                     ,
)                   {
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
  const intent                   = {
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

export function requestCandidate(
  request               ,
  input           ,
  source                         ,
)                   {
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
  const candidate                   = {
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
