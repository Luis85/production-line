import {
  validateRequestGateEvidence,
                           
} from "./request-gate.js";
import { ValidationError } from "./errors.js";
import { object, identifier, text, sha256, gitCommit } from "./validation.js";
                                                    
                                                    

/** Every measurement has an explicit unit and scope; unavailable mock evidence stays null. */
export function validateSnapshot(value         )           {
  const root = object(value, "Snapshot", [
    "schemaVersion",
    "id",
    "pairId",
    "phase",
    "capturedAt",
    "workerId",
    "project",
    "taskId",
    "attempt",
    "profileId",
    "provider",
    "mode",
    "configuration",
    "runtime",
    "execution",
    "resources",
    "health",
    "usage",
    "quality",
    "provenance",
    "review",
    "requestGate",
  ]);
  const invalid = (message        )        => {
    throw new ValidationError(message);
  };
  const finite = (value         , name        , integer = false)         => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isSafeInteger(value))
    )
      invalid(
        `${name}: finite nonnegative ${integer ? "safe integer" : "number"} required`,
      );
    return value          ;
  };
  const timestamp = (value         , name        ) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    )
      invalid(`${name}: UTC ISO timestamp required`);
  };
  if (
    root.schemaVersion !== 1 ||
    !["before", "after"].includes(root.phase          ) ||
    !["mock", "cli"].includes(root.mode          ) ||
    !["claude", "codex"].includes(root.provider          )
  )
    invalid("Invalid snapshot envelope");
  for (const name of ["pairId", "workerId", "project", "taskId", "profileId"])
    if (identifier(root[name], name) !== root[name])
      invalid(`${name}: identifier must not contain surrounding whitespace`);
  if (root.id !== root.pairId + "-" + root.phase)
    invalid("Invalid snapshot identity");
  if (finite(root.attempt, "attempt", true) < 1)
    invalid("attempt must be positive");
  timestamp(root.capturedAt, "capturedAt");
  if (root.requestGate !== undefined) {
    const gate = validateRequestGateEvidence(root.requestGate);
    if (root.phase !== "after")
      invalid("Gate receipts belong to terminal evidence.");
    if (executionGateMismatch(root, gate))
      invalid("Readiness hold requires a blocked readiness receipt.");
  }
  if (
    (root.execution                           )?.outcome === "gate_blocked" &&
    root.requestGate === undefined
  )
    invalid("Readiness hold requires a gate receipt.");
  const runtime = object(root.runtime, "runtime", [
    "processInstanceId",
    "node",
    "platform",
    "arch",
    "workerVersion",
    "adapterVersion",
  ]);
  for (const key of [
    "processInstanceId",
    "node",
    "platform",
    "arch",
    "workerVersion",
    "adapterVersion",
  ])
    text(runtime[key], `runtime.${key}`, 100);
  identifier(runtime.processInstanceId, "processInstanceId");
  const execution = object(root.execution, "execution", [
    "outcome",
    "durationMs",
    "timingSource",
    "error",
  ]);
  if (
    !["monotonic", "unavailable_after_restart"].includes(
      execution.timingSource          ,
    )
  )
    invalid("Invalid timing source");
  if (execution.durationMs !== null) finite(execution.durationMs, "durationMs");
  if (execution.error !== null) text(execution.error, "execution.error", 300);
  if (
    root.phase === "before" &&
    (execution.outcome !== "pending" ||
      execution.durationMs !== null ||
      execution.error !== null)
  )
    invalid("Before snapshot must be pending without duration/error");
  if (
    root.phase === "after" &&
    ![
      "simulated",
      "change-set",
      "failed",
      "interrupted",
      "gate_blocked",
    ].includes(execution.outcome          )
  )
    invalid("After snapshot requires terminal outcome");
  if (
    (execution.outcome === "simulated" && root.mode !== "mock") ||
    (execution.outcome === "change-set" && root.mode !== "cli")
  )
    invalid("Execution outcome does not match mode");
  if (root.mode === "cli" && root.provider !== "codex")
    invalid("Live provider must be Codex");
  if (execution.outcome === "change-set") {
    const review = object(root.review, "Review", [
      "baseCommit",
      "patchSha256",
      "patchBytes",
      "artifactPath",
    ]);
    gitCommit(review.baseCommit, "review.baseCommit");
    sha256(review.patchSha256, "review.patchSha256");
    if (
      finite(review.patchBytes, "review.patchBytes", true) < 1 ||
      Number(review.patchBytes) > 1048576 ||
      review.artifactPath !== `review/${root.pairId}/change.patch`
    )
      invalid("Invalid review artifact");
  } else if (root.review !== undefined)
    invalid("Review evidence requires a live change-set");
  if (
    execution.timingSource === "unavailable_after_restart" &&
    execution.durationMs !== null
  )
    invalid("Restarted timing must be unavailable");
  const resources = object(root.resources, "resources", [
    "scope",
    "rssBytes",
    "heapUsedBytes",
    "peakRssBytes",
    "cpuUserMicros",
    "cpuSystemMicros",
    "cpuDeltaMicros",
    "uptimeSeconds",
    "hostLoad1m",
  ]);
  if (resources.scope !== "worker_process")
    invalid("Resources must declare worker_process scope");
  for (const key of [
    "rssBytes",
    "heapUsedBytes",
    "peakRssBytes",
    "cpuUserMicros",
    "cpuSystemMicros",
  ])
    finite(resources[key], key, true);
  if (resources.cpuDeltaMicros !== null)
    finite(resources.cpuDeltaMicros, "cpuDeltaMicros", true);
  for (const key of ["uptimeSeconds", "hostLoad1m"])
    finite(resources[key], key);
  if (root.phase === "before" && resources.cpuDeltaMicros !== null)
    invalid("Before snapshot cannot contain CPU delta");
  const health = object(root.health, "health", [
    "serverLastContactAt",
    "heartbeatErrors",
    "eventLoopDelayP95Ms",
    "recoveredAfterCrash",
  ]);
  if (health.serverLastContactAt !== null)
    timestamp(health.serverLastContactAt, "serverLastContactAt");
  finite(health.heartbeatErrors, "heartbeatErrors", true);
  if (health.eventLoopDelayP95Ms !== null)
    finite(health.eventLoopDelayP95Ms, "eventLoopDelayP95Ms");
  if (typeof health.recoveredAfterCrash !== "boolean")
    invalid("recoveredAfterCrash must be boolean");
  if (
    health.recoveredAfterCrash &&
    (root.phase !== "after" ||
      !["interrupted", "simulated", "change-set", "gate_blocked"].includes(
        String(execution.outcome),
      ) ||
      execution.timingSource !== "unavailable_after_restart" ||
      resources.cpuDeltaMicros !== null)
  )
    invalid("Inconsistent recovered snapshot");
  const usageKeys = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "providerReportedCostUsd",
    "estimatedCostUsd",
    "subscriptionAllocatedCostUsd",
    "subscriptionRemaining",
  ];
  const usage = object(root.usage, "usage", [...usageKeys, "source", "reason"]);
  if (
    usage.source !==
    (root.mode === "mock" ? "unavailable_mock" : "unavailable_provider")
  )
    invalid("Mock usage must declare unavailable_mock");
  text(usage.reason, "usage.reason", 1000);
  for (const key of usageKeys)
    if (usage[key] !== null)
      invalid(`Mock ${key} must be null, not measured or estimated`);
  const qualityKeys = [
    "testsTotal",
    "testsPassed",
    "coveragePercent",
    "lintErrors",
    "securityFindings",
  ];
  const quality = object(root.quality, "quality", [
    ...qualityKeys,
    "build",
    "tests",
    "gate",
  ]);
  if (
    quality.build !== "not_run" ||
    quality.tests !== "not_run" ||
    quality.gate !== "not_evaluated"
  )
    invalid("Mock quality must remain unevaluated");
  for (const key of qualityKeys)
    if (quality[key] !== null) invalid(`Mock ${key} must be null`);
  const provenance = object(root.provenance, "provenance", [
    "repoBaseCommit",
    "testedCommit",
    "contextManifestHash",
    "skillsVersion",
    "iterationId",
    "featureId",
    "sourceCommit",
    "policyVersion",
    "configurationHash",
    "systemPromptHash",
    "artifactPath",
  ]);
  for (const key of ["repoBaseCommit", "testedCommit", "sourceCommit"])
    if (provenance[key] !== null) gitCommit(provenance[key], key);
  if (provenance.contextManifestHash !== null)
    sha256(provenance.contextManifestHash, "contextManifestHash");
  for (const key of ["iterationId", "featureId"])
    if (provenance[key] !== null) identifier(provenance[key], key);
  if (provenance.skillsVersion !== null)
    text(provenance.skillsVersion, "skillsVersion", 100);
  text(provenance.policyVersion, "policyVersion", 100);
  // Schema v1 historically accepted labels; preserve their provenance without inventing digests.
  text(provenance.configurationHash, "configurationHash", 100);
  text(provenance.systemPromptHash, "systemPromptHash", 100);
  const canonicalPath = `.factory/runs/${root.taskId}/attempt-${root.attempt}/${root.pairId}/${root.phase}.json`;
  if (provenance.artifactPath !== canonicalPath)
    invalid("Snapshot artifact path mismatch");
  const configuration = object(root.configuration, "configuration");
  // Limit configuration depth and reject non-JSON/non-finite values even for direct callers.
  const seen = new Set        ();
  let count = 0;
  const visit = (v         , depth        )       => {
    if (++count > 1000 || depth > 8)
      invalid("Snapshot configuration is too complex");
    if (v === null || typeof v === "boolean" || typeof v === "string") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) invalid("Configuration numbers must be finite");
      return;
    }
    if (typeof v !== "object" || !v || seen.has(v))
      invalid("Configuration must contain acyclic JSON values");
    seen.add(v          );
    if (!Array.isArray(v)) object(v, "configuration object");
    for (const child of Object.values(v          )) visit(child, depth + 1);
    seen.delete(v          );
  };
  visit(configuration, 0);
  if (
    new TextEncoder().encode(JSON.stringify(configuration)).byteLength > 16384
  )
    invalid("Snapshot configuration limit: 16 KiB");
  return root                       ;
}

function executionGateMismatch(
  root                         ,
  gate                     ,
) {
  return (
    (root.execution                           )?.outcome === "gate_blocked" &&
    (gate.stage !== "ready" || gate.status !== "blocked")
  );
}
