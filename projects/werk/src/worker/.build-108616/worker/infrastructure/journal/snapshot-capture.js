import { randomUUID } from "node:crypto";
import { loadavg } from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { buildInfo } from "../../../shared/build-info.js";
                                                                  
import {               } from "../../../shared/snapshots.js";
                                                                 

                        
                               
                                                      
                                    
                     
                     
 
const processInstanceId = randomUUID();

export function captureSnapshot(
  state              ,
  task      ,
  workerId        ,
  profile         ,
  status                ,
  phase                    ,
  before           ,
  outcome                                   = "pending",
  error                = null,
  recovered = false,
)           {
  const memory = process.memoryUsage(),
    cpu = process.cpuUsage(),
    usage = process.resourceUsage();
  const lease = task.lease ;
  if (phase === "before") {
    state.started.set(lease, performance.now());
  }
  const duration =
    phase === "after" && !recovered && state.started.has(lease)
      ? performance.now() - state.started.get(lease) 
      : null;
  if (phase === "after") state.started.delete(lease);
  const sameProcess = before?.runtime.processInstanceId === processInstanceId;
  return {
    schemaVersion: 1,
    id: lease + "-" + phase,
    pairId: lease,
    phase,
    capturedAt: new Date().toISOString(),
    workerId,
    project: task.project,
    taskId: task.id,
    attempt: task.attempt,
    profileId: profile.id,
    provider: profile.provider,
    mode: profile.mode,
    configuration: {
      ...state.settings,
      profileMaxParallel: profile.maxParallel ?? 1,
    },
    runtime: {
      processInstanceId,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      workerVersion: buildInfo.version,
      adapterVersion: profile.mode === "cli" ? "codex-cli-1" : "mock-1",
    },
    execution: {
      outcome,
      durationMs: duration,
      timingSource: recovered ? "unavailable_after_restart" : "monotonic",
      error: error ? error.slice(0, 300) : null,
    },
    resources: {
      scope: "worker_process",
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      peakRssBytes: usage.maxRSS * 1024,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      cpuDeltaMicros:
        phase === "after" && sameProcess && !recovered
          ? Math.max(
              0,
              cpu.user +
                cpu.system -
                before .resources.cpuUserMicros -
                before .resources.cpuSystemMicros,
            )
          : null,
      uptimeSeconds: process.uptime(),
      hostLoad1m: loadavg()[0],
    },
    health: {
      serverLastContactAt: status.lastContact,
      heartbeatErrors: status.heartbeatErrors,
      eventLoopDelayP95Ms:
        phase === "after" && !recovered
          ? state.histogram.percentile(95) / 1e6
          : null,
      recoveredAfterCrash: recovered,
    },
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      providerReportedCostUsd: null,
      estimatedCostUsd: null,
      subscriptionAllocatedCostUsd: null,
      subscriptionRemaining: null,
      source:
        profile.mode === "cli" ? "unavailable_provider" : "unavailable_mock",
      reason:
        profile.mode === "cli"
          ? "Provider usage and independent quality checks are not collected."
          : "No provider CLI ran. Subscription cost allocation requires a separate accounting policy.",
    },
    quality: {
      build: "not_run",
      tests: "not_run",
      testsTotal: null,
      testsPassed: null,
      coveragePercent: null,
      lintErrors: null,
      securityFindings: null,
      gate: "not_evaluated",
    },
    provenance: {
      iterationId: task.source?.iterationId ?? null,
      featureId: task.context?.featureId ?? task.source?.featureId ?? null,
      sourceCommit: task.context?.commit ?? task.source?.commit ?? null,
      repoBaseCommit: null,
      testedCommit: null,
      contextManifestHash:
        task.context?.sha256 ??
        before?.provenance.contextManifestHash ??
        null,
      skillsVersion: null,
      policyVersion:
        profile.mode === "cli" ? "review-required-1" : "mock-only-1",
      configurationHash: state.configHash,
      systemPromptHash: state.promptHash,
      artifactPath: `.factory/runs/${task.id}/attempt-${task.attempt}/${lease}/${phase}.json`,
    },
  };
}
