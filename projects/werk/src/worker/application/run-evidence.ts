/** Worker-session evidence excludes prompt text, credentials, provider subprocess accounting and inferred prices. */
export interface ProviderUsage {
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null;
  costBasis?: 'reported_estimate' | 'reported_billed' | 'unavailable' | 'unknown';
  providerReportedCostUsd: number | null; source: 'provider_reported' | 'unavailable'; reason: string | null;
}
export const unknownUsage = (reason = 'The provider did not report usage for this attempt.'): ProviderUsage => ({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: null, costBasis: 'unavailable', source: 'unavailable', reason });
export type RunOutcome = 'queued' | 'running' | 'completed' | 'review' | 'failed' | 'cancelled' | 'interrupted' | 'waiting_input' | 'escalated';
export interface RunMetadata { sessionId: string; taskId: string; kind: 'chat' | 'local' | 'orchestrator'; title: string; provider: string; model: string; }
export interface ConsumptionTotals {
  runs: number; reportedRuns: number;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; providerReportedCostUsd: number | null;
  coverage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; providerReportedCostUsd: number };
}
export interface RunResources { scope: 'worker_process'; processInstanceId: string; rssBytes: number; heapUsedBytes: number; cpuUserMicros: number; cpuSystemMicros: number; uptimeSeconds: number; }
export interface RunSnapshot { measurement: 'execution_boundary' | 'recovery' | 'cancellation'; capturedAt: string; state: RunOutcome; resources: RunResources; consumption: ConsumptionTotals; }
export interface WorkerRun extends RunMetadata {
  schemaVersion: 1; id: string; sequence: number; attempt: number; outcome: RunOutcome;
  acceptedAt: string; before: RunSnapshot | null; after: RunSnapshot | null; startedAt: string | null;
  durationMs: number | null; queueDurationMs: number | null; usage: ProviderUsage;
  resourceDelta: { scope: 'worker_process_between_snapshots'; cpuUserMicros: number | null; cpuSystemMicros: number | null };
}
export interface RunQuery { sessionId?: string; taskId?: string; provider?: string; kind?: RunMetadata['kind']; outcome?: RunOutcome; since?: string; until?: string; limit?: number; offset?: number; asOf?: number; cursor?: string; }
export interface RunPage { schemaVersion: 1; rows: WorkerRun[]; total: number; nextOffset: number | null; nextCursor: string | null; asOf: number; scope: 'worker_session_executions'; }
export interface RunAnalysis {
  schemaVersion: 1;
  scope: 'worker_session_executions'; asOf: number; total: number; completedPairs: number;
  outcomes: Record<string, number>; consumption: ConsumptionTotals;
  duration: { measuredRuns: number; totalMs: number | null; meanMs: number | null };
  resources: { scope: 'worker_process_between_snapshots'; measuredRuns: number; cpuUserMicros: number | null; cpuSystemMicros: number | null; peakObservedRssBytes: number | null };
  notes: string[];
}
export interface RunEvidence {
  begin(metadata: RunMetadata): Promise<WorkerRun>;
  start(id: string): Promise<void>;
  observeUsage?(id: string, usage: ProviderUsage): void;
  finish(id: string, outcome: Exclude<RunOutcome, 'queued' | 'running'>, usage?: ProviderUsage): Promise<WorkerRun>;
}
