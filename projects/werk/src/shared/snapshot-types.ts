import { type RequestGateEvidence } from "./request-gate.js";

export interface Snapshot {
  schemaVersion: 1;
  id: string;
  pairId: string;
  phase: "before" | "after";
  capturedAt: string;
  workerId: string;
  project: string;
  taskId: string;
  attempt: number;
  profileId: string;
  provider: string;
  mode: "mock" | "cli";
  requestGate?: RequestGateEvidence;
  review?: {
    baseCommit: string;
    patchSha256: string;
    patchBytes: number;
    artifactPath: string;
  };
  configuration: Record<string, unknown>;
  runtime: {
    processInstanceId: string;
    node: string;
    platform: string;
    arch: string;
    workerVersion: string;
    adapterVersion: string;
  };
  execution: {
    outcome:
      | "pending"
      | "simulated"
      | "change-set"
      | "failed"
      | "interrupted"
      | "gate_blocked";
    durationMs: number | null;
    timingSource: "monotonic" | "unavailable_after_restart";
    error: string | null;
  };
  resources: {
    scope: "worker_process";
    rssBytes: number;
    heapUsedBytes: number;
    peakRssBytes: number;
    cpuUserMicros: number;
    cpuSystemMicros: number;
    cpuDeltaMicros: number | null;
    uptimeSeconds: number;
    hostLoad1m: number;
  };
  health: {
    serverLastContactAt: string | null;
    heartbeatErrors: number;
    eventLoopDelayP95Ms: number | null;
    recoveredAfterCrash: boolean;
  };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    providerReportedCostUsd: number | null;
    estimatedCostUsd: number | null;
    subscriptionAllocatedCostUsd: number | null;
    subscriptionRemaining: number | null;
    source: "unavailable_mock" | "unavailable_provider";
    reason: string;
  };
  quality: {
    build: "not_run";
    tests: "not_run";
    testsTotal: number | null;
    testsPassed: number | null;
    coveragePercent: number | null;
    lintErrors: number | null;
    securityFindings: number | null;
    gate: "not_evaluated";
  };
  provenance: {
    repoBaseCommit: string | null;
    testedCommit: string | null;
    contextManifestHash: string | null;
    skillsVersion: string | null;
    iterationId: string | null;
    featureId: string | null;
    sourceCommit: string | null;
    policyVersion: string;
    configurationHash: string;
    systemPromptHash: string;
    artifactPath: string;
  };
}
