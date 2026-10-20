import { DomainError } from '../../shared/errors.js';
import { ProviderModelError, parseModelResult, type ModelResult } from './model-contract.js';
import type { ChatMessage } from './conversation.js';
import type { GateInput, GateReviewIntent, GateStage, WorkerRequest } from './request-gates.js';
import { validateDeliveryReadinessResult, readinessProtocol } from './delivery-readiness.js';
import { validateDeliveryPolicySnapshot } from './delivery-policy.js';
type AdvisoryResult = NonNullable<GateReviewIntent['result']>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, limit: number): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= limit;
const protocol = (): never => {
  throw new ProviderModelError("protocol");
};
/** Model output is advisory text only: no facts, policy, authority or approved-file changes. */
function parseAdvisoryReview(
  text: string,
  input: GateInput,
  stage: GateStage,
  kind: "review" | "rework" = "review",
): AdvisoryResult {
  if (typeof text !== "string" || Buffer.byteLength(text) > 262144) protocol();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return protocol();
  }
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "findings", "candidate", "readiness"].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.findings) ||
    value.findings.length > 32
  )
    return protocol();
  const findings = value.findings.map((raw) => {
    if (
      !object(raw) ||
      Object.keys(raw).some(
        (key) => !["kind", "message", "blocking"].includes(key),
      ) ||
      !["question", "issue", "gap"].includes(String(raw.kind)) ||
      !boundedText(raw.message, 4000) ||
      typeof raw.blocking !== "boolean"
    )
      return protocol();
    return {
      kind: raw.kind as "question" | "issue" | "gap",
      message: raw.message,
      blocking: raw.blocking,
    };
  });
  const context = input.context as { deliveryPolicy?: unknown } | undefined;
  const structured = stage === 'ready' && !!(context?.deliveryPolicy && validateDeliveryPolicySnapshot(context.deliveryPolicy).profile.readiness);
  if (value.readiness !== undefined && !structured || structured && value.readiness === undefined) protocol();
  let readiness; try { readiness = structured ? validateDeliveryReadinessResult(value.readiness) : undefined; } catch { return protocol(); }
  let candidate: GateInput | undefined;
  if (value.candidate !== undefined) {
    if (
      !object(value.candidate) ||
      Object.keys(value.candidate).some((key) => key !== "message") ||
      !boundedText(value.candidate.message, 8000)
    )
      return protocol();
    candidate = { ...structuredClone(input), message: value.candidate.message };
  }
  return {
    summary:
      kind === "rework"
        ? "Advisory rework candidate."
        : stage === "ready"
          ? "Advisory readiness review."
          : "Advisory completion review.",
    findings,
    ...(readiness ? { readiness } : {}),
    ...(candidate ? { candidate } : {}),
  };
}
export function advisoryResult(
  result: ModelResult,
  input: GateInput,
  stage: GateStage,
  kind: "review" | "rework",
): AdvisoryResult {
  if (result.type === "completed")
    return parseAdvisoryReview(result.text, input, stage, kind);
  // A typed blocking question is the other defined model protocol, never arbitrary prose.
  const validated = parseModelResult(
    JSON.stringify({ werkInteraction: result.request }),
  );
  if (
    validated.type !== "needs_input" ||
    !boundedText(validated.request.message, 4000)
  )
    return protocol();
  return {
    summary: "Advisory review needs an operator decision.",
    findings: [
      {
        kind: validated.request.kind === "question" ? "question" : "issue",
        message: validated.request.message,
        blocking: true,
      },
    ],
  };
}
export function reviewMessage(
  request: WorkerRequest,
  intent: GateReviewIntent,
): ChatMessage {
  const evaluation = request.evaluations.find(
    (item) => item.id === intent.evaluationId,
  );
  const payload = {
    requestId: request.id,
    stage: intent.stage,
    intent: intent.kind,
    inputRevision: request.inputRevision,
    inputHash: intent.inputHash,
    policyDigest: intent.policyDigest,
    input: request.input,
    rules: evaluation?.rules ?? [],
    findings: request.findings.filter((item) => item.status === "open"),
    output:
      intent.stage === "done" ? (request.execution?.result ?? null) : null,
  };
  const data = JSON.stringify(payload);
  if (Buffer.byteLength(data) > 262144)
    throw new DomainError("too_large", "Advisory context exceeds its bound.");
  let instruction =
    'Review only the supplied request and deterministic gate observations. You have no tools, commands or live environment access. Never claim tests, builds, operator acceptance or policy facts. Do not change policy, kind, approved paths, criteria or context. Findings are advisory; only deterministic evaluation and explicit operator decisions authorize execution. Return ONLY JSON {"schemaVersion":1,"findings":[{"kind":"question|issue|gap","message":"bounded actionable observation","blocking":true}],"candidate":{"message":"optional revised request text"}}. Maximum 32 findings; each message at most 4000 characters; candidate.message at most 8000 characters. No other fields. An empty findings array is valid. ' +
    (intent.kind === "rework"
      ? "This is an explicit rework request: propose revised text without inventing answers to unresolved questions."
      : "You may propose improved text but must not treat it as accepted input.");
  const context = request.input.context as { deliveryPolicy?: unknown } | undefined;
  if (intent.stage === 'ready' && context?.deliveryPolicy && validateDeliveryPolicySnapshot(context.deliveryPolicy).profile.readiness) instruction = instruction.replace('No other fields.', 'Only the listed fields and the following structured readiness field are allowed.') + '\n' + readinessProtocol;
  if (intent.provider.id === 'cursor-cli') instruction = instruction.replace('You have no tools, commands or live environment access.', 'This review runs in Cursor ask mode. Native tools and hooks remain governed by the operator’s Cursor permissions; restrict your review to the supplied evidence and do not execute changes.');
  return {
    id: intent.id,
    role: "user",
    state: "complete",
    at: intent.createdAt,
    text: instruction + "\nRequest data:\n" + data,
  };
}
