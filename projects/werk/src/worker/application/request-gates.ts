import { createHash } from "node:crypto";
import { DomainError } from "../../shared/errors.js";
import { gateFacts, type GatePolicy, type GateRule, type GateFact, type GateFactSnapshot, type GateInput, type GateStage, type RequestKind, type GateRuleResult } from './request-gate-contracts.js';
export * from './request-gate-contracts.js';

const invalid = (message: string): never => {
  throw new DomainError("invalid_input", message);
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const gateIdentifier = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
function exact(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key)))
    invalid(`Invalid ${label} fields.`);
  return value as Record<string, unknown>;
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.keys(value as object)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) => JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key]),
      )
      .join(",") +
    "}"
  );
}
export const gateDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export function defaultGatePolicy(): GatePolicy {
  const message: GateRule[] = [
    { id: "message-present", fact: "input.messageLength", op: "gte", value: 1 },
    {
      id: "message-bounded",
      fact: "input.messageLength",
      op: "lte",
      value: 8000,
    },
  ];
  const completed: GateRule[] = [
    {
      id: "completed",
      fact: "execution.outcome",
      op: "eq",
      value: "completed",
    },
    { id: "output-present", fact: "output.nonEmpty", op: "eq", value: true },
    { id: "no-pending-input", fact: "pending.count", op: "eq", value: 0 },
  ];
  return {
    schemaVersion: 1,
    id: "werk-default",
    version: 1,
    ready: {
      chat: message,
      patch: [
        ...message,
        {
          id: "approved-files",
          fact: "input.approvedFileCount",
          op: "gte",
          value: 1,
        },
        {
          id: "approved-paths",
          fact: "input.pathsValid",
          op: "eq",
          value: true,
        },
      ],
    },
    done: {
      chat: completed,
      patch: [
        ...completed,
        {
          id: "valid-patch",
          fact: "output.protocolValid",
          op: "eq",
          value: true,
        },
        {
          id: "patch-present",
          fact: "output.patchPresent",
          op: "eq",
          value: true,
        },
      ],
    },
    reviewer: { enabled: true, provider: "same", maxAttempts: 1 },
    rework: { maxAttempts: 3 },
  };
}
export function validateGatePolicy(value: unknown): GatePolicy {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 65536)
    invalid("Gate policy exceeds 64 KiB.");
  const root = exact(
    value,
    ["schemaVersion", "id", "version", "ready", "done", "reviewer", "rework"],
    "gate policy",
  );
  if (
    root.schemaVersion !== 1 ||
    !gateIdentifier(root.id) ||
    !Number.isSafeInteger(root.version) ||
    Number(root.version) < 1
  )
    invalid(
      "Gate policy requires schemaVersion 1, an ID and positive version.",
    );
  for (const stage of ["ready", "done"]) {
    const kinds = exact(root[stage], ["chat", "patch"], stage);
    for (const kind of ["chat", "patch"]) {
      const rules = kinds[kind];
      if (!Array.isArray(rules) || rules.length > 32)
        invalid("Each gate requires an array of at most 32 rules.");
      const ids = new Set();
      for (const raw of rules as unknown[]) {
        const rule = exact(raw, ["id", "fact", "op", "value"], "gate rule");
        if (!gateIdentifier(rule.id) || ids.has(rule.id))
          invalid("Gate rule IDs must be unique within their stage and kind.");
        ids.add(rule.id);
        if (
          typeof rule.fact !== "string" ||
          !Object.hasOwn(gateFacts, rule.fact)
        )
          invalid("Unknown gate fact.");
        const type = gateFacts[rule.fact as GateFact];
        if (
          typeof rule.op !== "string" ||
          !["eq", "neq", "gte", "lte"].includes(rule.op) ||
          (["gte", "lte"].includes(rule.op) && type !== "number")
        )
          invalid("Unsupported operator for gate fact.");
        if (
          typeof rule.value !== type ||
          (type === "number" &&
            (!Number.isSafeInteger(rule.value) || Number(rule.value) < 0)) ||
          (type === "string" && String(rule.value).length > 200)
        )
          invalid("Gate rule value has the wrong type or bounds.");
      }
    }
  }
  const reviewer = exact(
    root.reviewer,
    ["enabled", "provider", "maxAttempts"],
    "reviewer",
  );
  if (
    typeof reviewer.enabled !== "boolean" ||
    reviewer.provider !== "same" ||
    reviewer.maxAttempts !== 1
  )
    invalid("Reviewer requires enabled, provider: same and maxAttempts: 1.");
  const rework = exact(root.rework, ["maxAttempts"], "rework");
  if (
    !Number.isSafeInteger(rework.maxAttempts) ||
    Number(rework.maxAttempts) < 0 ||
    Number(rework.maxAttempts) > 3
  )
    invalid("Rework maxAttempts must be 0–3.");
  return structuredClone(value) as GatePolicy;
}
export function validateGateInput(value: unknown): GateInput {
  const input = exact(
    value,
    ["kind", "title", "message", "criteria", "files", "context"],
    "request input",
  );
  if (
    typeof input.kind !== "string" ||
    !["chat", "patch"].includes(input.kind) ||
    typeof input.title !== "string" ||
    input.title.length > 200 ||
    typeof input.message !== "string" ||
    input.message.length > 64000
  )
    invalid("Request input requires bounded kind, title and message.");
  if (
    input.criteria !== undefined &&
    (!Array.isArray(input.criteria) ||
      input.criteria.length > 64 ||
      input.criteria.some((v) => typeof v !== "string" || v.length > 2000))
  )
    invalid("Request criteria must be bounded strings.");
  if (input.files !== undefined) {
    if (!Array.isArray(input.files) || input.files.length > 100)
      invalid("At most 100 approved file facts are supported.");
    for (const raw of input.files as unknown[]) {
      const file = exact(raw, ["path", "bytes", "sha256"], "approved file");
      if (
        typeof file.path !== "string" ||
        file.path.length > 500 ||
        (file.bytes !== null &&
          (!Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0)) ||
        (file.sha256 !== undefined &&
          (typeof file.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(file.sha256)))
      )
        invalid("Invalid approved file facts.");
    }
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 1048576)
    invalid("Request input exceeds 1 MiB.");
  return structuredClone(input) as unknown as GateInput;
}
export function validateGateFacts(value: unknown): GateFactSnapshot {
  if (!isObject(value)) invalid("Gate facts must be an object.");
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      !Object.hasOwn(gateFacts, key) ||
      (item !== null &&
        (typeof item !== gateFacts[key as GateFact] ||
          (typeof item === "number" &&
            (!Number.isSafeInteger(item) || item < 0)) ||
          (typeof item === "string" && item.length > 200)))
    )
      invalid("Invalid or unsupported gate fact.");
  }
  return structuredClone(value) as GateFactSnapshot;
}
export function inputGateFacts(input: GateInput): GateFactSnapshot {
  const files = input.files ?? [];
  return {
    "input.kind": input.kind,
    "input.titleLength": input.title.trim().length,
    "input.messageLength": input.message.trim().length,
    "input.criteriaCount": input.criteria?.length ?? 0,
    "input.approvedFileCount": files.length,
    "input.approvedBytes": files.some((f) => f.bytes === null)
      ? null
      : files.reduce((sum, f) => sum + (f.bytes ?? 0), 0),
    "input.pathsValid":
      new Set(files.map((f) => f.path)).size === files.length &&
      files.every((f) => {
        // Implementation folder approvals end in one "/"; the folder name follows the file rules.
        const path = f.path.endsWith("/") ? f.path.slice(0, -1) : f.path;
        return (
          !!path &&
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !path
            .split("/")
            .some((part) => !part || part === "." || part === "..") &&
          !/^[a-z]:/i.test(path) &&
          !path.includes("\0")
        );
      }),
  };
}
export function evaluateGate(
  policy: GatePolicy,
  stage: GateStage,
  kind: RequestKind,
  facts: GateFactSnapshot,
): { passed: boolean; rules: GateRuleResult[] } {
  const rules = policy[stage][kind].map((rule) => {
    const observed = facts[rule.fact] ?? null;
    const matches =
      observed === null
        ? null
        : rule.op === "eq"
          ? observed === rule.value
          : rule.op === "neq"
            ? observed !== rule.value
            : rule.op === "gte"
              ? Number(observed) >= Number(rule.value)
              : Number(observed) <= Number(rule.value);
    return {
      ruleId: rule.id,
      fact: rule.fact,
      expected: rule.value,
      observed,
      result: matches === null ? "unknown" : matches ? "pass" : "fail",
    } as GateRuleResult;
  });
  // Candidate verification is execution authority, not an optional custom policy rule.
  // Absence preserves legacy proposal/chat behavior. Eligibility is a separate trusted coordinator fact
  // requiring exact candidate-bound, policy-permitted decisions; it never changes the observed result.
  if (stage === "done" && facts["output.verificationPassed"] === false && facts["output.verificationEligible"] !== true)
    rules.push({
      ruleId: "worker-required-verification",
      fact: "output.verificationPassed",
      expected: true,
      observed: false,
      result: "fail",
    });
  return { passed: rules.every((rule) => rule.result === "pass"), rules };
}
