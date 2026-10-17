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
