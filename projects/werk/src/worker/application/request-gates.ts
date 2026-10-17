import { createHash } from "node:crypto";
import { DomainError } from "../../shared/errors.js";
import type {
  ModelProvider,
  ModelResult,
  ModelRequest,
} from "./model-contract.js";
import type { ProviderUsage } from "./run-evidence.js";

export type GateStage = "ready" | "done";
export type RequestKind = "chat" | "patch";
export type RequestPhase =
  | "readiness"
  | "needs_rework"
  | "ready"
  | "running"
  | "waiting_input"
  | "escalated"
  | "review"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";
export const gateFacts = {
  "input.kind": "string",
  "input.titleLength": "number",
  "input.messageLength": "number",
  "input.criteriaCount": "number",
  "input.approvedFileCount": "number",
  "input.approvedBytes": "number",
  "input.pathsValid": "boolean",
  "output.nonEmpty": "boolean",
  "output.protocolValid": "boolean",
  "output.patchPresent": "boolean",
  "output.changedFileCount": "number",
  "output.verificationPassed": "boolean",
  "output.requiredCheckCount": "number",
  "output.candidateDigest": "string",
  "execution.recoverySafe": "boolean",
  "execution.outcome": "string",
  "pending.count": "number",
  "findings.blockingCount": "number",
  "operator.accepted": "boolean",
  "tests.passed": "boolean",
  "build.passed": "boolean",
} as const;
export type GateFact = keyof typeof gateFacts;
export type GateFactValue = string | number | boolean | null;
export type GateFactSnapshot = Partial<Record<GateFact, GateFactValue>>;
export interface GateRule {
  id: string;
  fact: GateFact;
  op: "eq" | "neq" | "gte" | "lte";
  value: string | number | boolean;
}
export interface GatePolicy {
  schemaVersion: 1;
  id: string;
  version: number;
  ready: Record<RequestKind, GateRule[]>;
  done: Record<RequestKind, GateRule[]>;
  reviewer: { enabled: boolean; provider: string; maxAttempts: 1 };
  rework: { maxAttempts: number };
}
export interface GateFile {
  path: string;
  bytes: number | null;
  sha256?: string;
}
/** Private accepted input; context is the owner's bounded immutable replay data, never credentials. */
export interface GateInput {
  kind: RequestKind;
  title: string;
  message: string;
  criteria?: string[];
  files?: GateFile[];
  context?: unknown;
}
export interface RequestOwner {
  sessionId: string;
  rootTurnId: string;
  taskId?: string;
  featureId?: string;
  remote?: { origin: string; taskId: string; attempt: number; lease: string };
}
export interface GateRuleResult {
  ruleId: string;
  fact: GateFact;
  expected: string | number | boolean;
  observed: GateFactValue;
  result: "pass" | "fail" | "unknown";
}
export interface GateEvaluation {
  id: string;
  stage: GateStage;
  inputRevision: number;
  inputHash: string;
  policyDigest: string;
  outputDigest: string | null;
  at: string;
  passed: boolean;
  facts: GateFactSnapshot;
  rules: GateRuleResult[];
}
export interface RequestFinding {
  id: string;
  kind: "question" | "issue" | "gap";
  message: string;
  blocking: boolean;
  source: "deterministic" | "reviewer" | "operator";
  evaluationId: string;
  ruleId?: string;
  status: "open" | "resolved";
  resolution?: { actor: "operator"; note: string; at: string };
}
export interface RequestCandidate {
  id: string;
  basedOnInputRevision: number;
  input: GateInput;
  inputHash: string;
  source: "operator" | "reviewer";
  createdAt: string;
  status: "pending" | "accepted" | "superseded";
}
export interface GateReviewIntent {
  id: string;
  requestId: string;
  kind: "review" | "rework";
  evaluationId: string;
  stage: GateStage;
  inputHash: string;
  policyDigest: string;
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  provider: ModelProvider;
  runId: string | null;
  dispatch: ModelRequest | null;
  result: {
    findings: {
      kind: "question" | "issue" | "gap";
      message: string;
      blocking?: boolean;
    }[];
    summary: string;
    candidate?: GateInput;
  } | null;
  usage: ProviderUsage | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}
export interface RequestExecution {
  turnId: string;
  runId: string;
  inputRevision: number;
  status:
    | "prepared"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  outcome: string | null;
  result: ModelResult | null;
  outputDigest: string | null;
  facts: GateFactSnapshot;
}
export interface WorkerRequest {
  schemaVersion: 1;
  id: string;
  owner: RequestOwner;
  revision: number;
  inputRevision: number;
  input: GateInput;
  inputHash: string;
  policy: GatePolicy;
  policyDigest: string;
  provider: ModelProvider;
  phase: RequestPhase;
  assignee: "operator" | "llm";
  createdAt: string;
  updatedAt: string;
  reworkCount: number;
  recoveryHold?: { code: string; at: string } | null;
  evaluations: GateEvaluation[];
  findings: RequestFinding[];
  candidates: RequestCandidate[];
  reviews: GateReviewIntent[];
  execution: RequestExecution | null;
  attestation: {
    actor: "operator";
    inputHash: string;
    outputDigest: string;
    note: string;
    at: string;
  } | null;
}
export interface RequestSummary {
  id: string;
  owner: RequestOwner;
  revision: number;
  inputRevision: number;
  inputHash: string;
  policyDigest: string;
  phase: RequestPhase;
  title: string;
  kind: RequestKind;
  assignee: "operator" | "llm";
  updatedAt: string;
}
export interface RequestEvent {
  schemaVersion: 1;
  id: string;
  sequence: number;
  requestId: string;
  revision: number;
  type: string;
  phase: RequestPhase;
  at: string;
  inputRevision: number;
  evaluationId?: string;
  turnId?: string;
  runId?: string;
}
export interface RequestCommand {
  action:
    | "execute"
    | "evaluate"
    | "assign"
    | "attest"
    | "resolve_finding"
    | "propose"
    | "accept_candidate"
    | "rework"
    | "cancel";
  requestId: string;
  expectedRevision: number;
  operationId: string;
  stage?: GateStage;
  assignee?: "operator" | "llm";
  note?: string;
  findingId?: string;
  input?: GateInput;
  candidateId?: string;
  inputHash?: string;
  outputDigest?: string;
}
export interface RequestGatePort {
  ensure(input: {
    owner: RequestOwner;
    input: GateInput;
    provider: ModelProvider;
    policy?: GatePolicy;
  }): WorkerRequest;
  get(id: string): WorkerRequest;
  forTurn(sessionId: string, turnId: string): WorkerRequest | undefined;
  forSession(sessionId: string): WorkerRequest | undefined;
  hasActiveReview(sessionId: string): boolean;
  bindTurn(id: string, turnId: string, inputRevision?: number): WorkerRequest;
  evaluate(id: string, stage: GateStage): GateEvaluation;
  prepareExecution(id: string, turnId: string, runId: string): WorkerRequest;
  startExecution(id: string, turnId: string, runId: string): WorkerRequest;
  recordResult(
    id: string,
    turnId: string,
    runId: string,
    result: ModelResult,
    facts?: GateFactSnapshot,
  ): WorkerRequest;
  holdRecovery(id: string, reason?: string): WorkerRequest;
  failExecution(
    id: string,
    turnId: string,
    status: "failed" | "cancelled" | "interrupted",
  ): WorkerRequest;
  command(input: RequestCommand): {
    request: WorkerRequest;
    duplicate: boolean;
  };
  deleteSession(sessionId: string): void;
}

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
      .filter((key) => (value as any)[key] !== undefined)
      .map(
        (key) => JSON.stringify(key) + ":" + canonicalJson((value as any)[key]),
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
          !["eq", "neq", "gte", "lte"].includes(String(rule.op)) ||
          (["gte", "lte"].includes(String(rule.op)) && type !== "number")
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
    !["chat", "patch"].includes(String(input.kind)) ||
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
      files.every(
        (f) =>
          !!f.path &&
          !f.path.startsWith("/") &&
          !f.path.includes("\\") &&
          !f.path
            .split("/")
            .some((part) => !part || part === "." || part === "..") &&
          !/^[a-z]:/i.test(f.path) &&
          !f.path.includes("\0"),
      ),
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
  // Absence preserves legacy proposal/chat behavior; only the coordinator emits false.
  if (stage === "done" && facts["output.verificationPassed"] === false)
    rules.push({
      ruleId: "worker-required-verification",
      fact: "output.verificationPassed",
      expected: true,
      observed: false,
      result: "fail",
    });
  return { passed: rules.every((rule) => rule.result === "pass"), rules };
}
