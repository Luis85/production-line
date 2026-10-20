import { assertExecutionStopObservation, validateExecutionRecoveryCommand, type ExecutionStopObservation, type UnknownExecutionReason } from '../../application/execution-recovery.js';
import { validateAuthenticationMode } from '../../application/provider-capabilities.js';
import type { ProviderId } from '../../application/provider-contract.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DomainError } from '../../../shared/errors.js';
import { openPrivateJournal } from './database.js';
import { validateRunLineage, unknownUsage, type ConsumptionTotals, type ProviderUsage, type RunAnalysis, type RunMetadata, type RunOutcome, type RunPage, type RunQuery, type RunResources, type WorkerRun } from '../../application/run-evidence.js';
const usageColumns = { inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens', providerReportedCostUsd: 'cost_usd' } as const;
const outcomes: RunOutcome[] = ['queued', 'running', 'completed', 'review', 'failed', 'cancelled', 'interrupted', 'waiting_input', 'escalated'];
const processInstanceId = randomUUID();
/** Append-only attempt identities, with bounded query pages; deleting sessions never removes evidence. */
export class WorkerRunJournal {
  private db!: DatabaseSync;
  private initialized = false;
  private clock = new Map<string, { accepted?: number; started?: number }>();
  private directory: string;
  constructor(directory: string) { this.directory = directory; }
  async init(recovery?: (runId: string) => { outcome: Exclude<RunOutcome, 'queued' | 'running'>; usage: ProviderUsage } | undefined, deliveryOwns?: (run: WorkerRun) => boolean) {
    if (this.initialized) return;
    await this.open();
    try { await this.recover(recovery, new Set(), deliveryOwns); } catch (error) { this.close(); throw error; }
  }
  async open() {
    if (this.initialized) return;
    this.db = await openPrivateJournal(this.directory, 'worker-runs.sqlite', 'Run evidence storage must be a regular file, not a symlink.');
    try {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
        kind TEXT NOT NULL, provider TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0, reported INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL,
        duration_ms REAL, cpu_user REAL, cpu_system REAL, rss_bytes INTEGER);
      CREATE INDEX IF NOT EXISTS worker_runs_session ON worker_runs(session_id, sequence);
      CREATE INDEX IF NOT EXISTS worker_runs_filter ON worker_runs(provider, outcome, sequence);
      CREATE TABLE IF NOT EXISTS execution_recovery_operations(operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, command_digest TEXT NOT NULL);`);
    this.initialized = true;
    } catch (error) { this.db.close(); this.initialized = false; throw error; }
  }
  queuedForRecovery(id: string): boolean {
    const run = this.get(id), row = this.db.prepare('SELECT * FROM worker_runs WHERE id=?').get(id);
    return !!row && row.finished === 0 && row.outcome === 'queued' && row.reported === 0 && row.session_id === run.sessionId && row.task_id === run.taskId && row.kind === run.kind && row.provider === run.provider && row.created_at === run.acceptedAt &&
      ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'duration_ms', 'cpu_user', 'cpu_system', 'rss_bytes'].every(key => row[key] === null);
  }
  async recover(recovery?: Parameters<WorkerRunJournal['init']>[0], retained: ReadonlySet<string> = new Set(), deliveryOwns?: (run: WorkerRun) => boolean) {
    for (const row of this.db.prepare('SELECT id FROM worker_runs WHERE finished=0 ORDER BY sequence').all()) {
      const id = String(row.id);
      if (retained.has(id) && this.queuedForRecovery(id)) continue;
      const known = recovery?.(id), run = this.get(id);
      const parent = run.parentRunId ? this.get(run.parentRunId) : undefined;
      // A delegated child borrows the parent's recovery boundary, including an operator's descendant-aware stop attestation.
      const parentOwns = parent && parent.sessionId === run.parentSessionId && parent.parentRunId === undefined
        && ['taskId', 'requestId', 'kind', 'provider', 'model', 'authenticationMode'].every(key => run[key as keyof RunMetadata] === parent[key as keyof RunMetadata])
        && (run.purpose ?? 'execution') === (parent.purpose ?? 'execution')
        && (parent.executionRecovery?.state === 'unknown' || parent.executionRecovery?.state === 'operator_confirmed_stopped');
      if (!known && run.startedAt && !parentOwns && !deliveryOwns?.(run)) this.reserveUnknown(id, 'worker_restarted');
      await this.complete(id, known?.outcome ?? 'interrupted', known?.usage ?? this.get(id).usage, true);
    }
  }
  close() { if (this.initialized) { this.db.close(); this.initialized = false; } this.clock.clear(); }
  private resources(): RunResources {
    const memory = process.memoryUsage(), cpu = process.cpuUsage();
    return { scope: 'worker_process', processInstanceId, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, uptimeSeconds: process.uptime() };
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private consumption(where = '1=1', values: (string | number)[] = []): ConsumptionTotals {
    const fields = Object.entries(usageColumns).map(([name, column]) => `SUM(${column}) AS ${name}, COUNT(${column}) AS ${name}Coverage`).join(', ');
    const row = this.db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(reported),0) AS reportedRuns, ${fields} FROM worker_runs WHERE finished=1 AND ${where}`).get(...values)!;
    const coverage = {} as ConsumptionTotals['coverage'], totals = {} as Pick<ConsumptionTotals, keyof typeof usageColumns>;
    for (const name of Object.keys(usageColumns) as (keyof typeof usageColumns)[]) { coverage[name] = Number(row[name + 'Coverage']); totals[name] = row[name] === null ? null : Number(row[name]); }
    return { runs: Number(row.runs), reportedRuns: Number(row.reportedRuns), ...totals, coverage };
  }
  private save(run: WorkerRun) { this.db.prepare('UPDATE worker_runs SET outcome=?, payload=? WHERE id=?').run(run.outcome, JSON.stringify(run), run.id); }
  async begin(metadata: RunMetadata): Promise<WorkerRun> {
    if (metadata.authenticationMode !== undefined) validateAuthenticationMode(metadata.authenticationMode, metadata.provider as ProviderId);
    if (metadata.purpose !== undefined && !['execution', 'gate_review', 'rework'].includes(metadata.purpose)) throw new DomainError('invalid_input', 'Invalid run purpose.');
    if (metadata.requestId !== undefined && (typeof metadata.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(metadata.requestId))) throw new DomainError('invalid_input', 'Invalid request identity.');
    validateRunLineage(metadata, metadata.parentRunId === undefined ? undefined : this.get(metadata.parentRunId));
    const id = randomUUID();
    const run = this.transaction(() => {
      const attempt = Number(this.db.prepare('SELECT COUNT(*) AS count FROM worker_runs WHERE session_id=?').get(metadata.sessionId)!.count) + 1;
      const acceptedAt = new Date().toISOString();
      const value: WorkerRun = { ...metadata, title: metadata.title.slice(0, 200), schemaVersion: 1, id, sequence: 0, attempt, outcome: 'queued', acceptedAt, before: null, after: null, startedAt: null, durationMs: null, queueDurationMs: null, usage: unknownUsage(), resourceDelta: { scope: 'worker_process_between_snapshots', cpuUserMicros: null, cpuSystemMicros: null } };
      const result = this.db.prepare('INSERT INTO worker_runs (id,session_id,task_id,kind,provider,outcome,created_at,payload) VALUES (?,?,?,?,?,?,?,?)').run(id, value.sessionId, value.taskId, value.kind, value.provider, value.outcome, acceptedAt, '{}');
      value.sequence = Number(result.lastInsertRowid); this.save(value); return value;
    });
    this.clock.set(id, { accepted: performance.now() }); return run;
  }
  async start(id: string) {
    const run = this.get(id); if (run.after) throw new DomainError('conflict', 'This execution attempt is already finished.'); if (run.startedAt) return;
    const timing = this.clock.get(id) ?? {}; timing.started = performance.now(); this.clock.set(id, timing);
    run.startedAt = new Date().toISOString(); run.outcome = 'running';
    run.before = { measurement: 'execution_boundary', capturedAt: run.startedAt, state: 'running', resources: this.resources(), consumption: this.consumption() };
    run.queueDurationMs = timing.accepted === undefined ? null : Math.max(0, timing.started - timing.accepted); this.save(run);
  }
  observeUsage(id: string, usage: ProviderUsage) {
    const run = this.get(id);
    if (run.after) return;
    run.usage = this.normalizeUsage(usage);
    this.save(run);
  }
  private normalizeUsage(usage: ProviderUsage) {
    const normalized = unknownUsage(usage.reason ?? undefined);
    for (const key of Object.keys(usageColumns) as (keyof typeof usageColumns)[]) {
      const value = usage[key];
      normalized[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 && (key === 'providerReportedCostUsd' ? value <= 1e9 : Number.isSafeInteger(value) && value <= 1e12) ? value : null;
    }
    normalized.source = Object.keys(usageColumns).some(key => normalized[key as keyof typeof usageColumns] !== null) ? 'provider_reported' : 'unavailable';
    normalized.costBasis = normalized.providerReportedCostUsd === null ? 'unavailable' : ['reported_estimate', 'reported_billed', 'unknown'].includes(usage.costBasis ?? '') ? usage.costBasis : 'unknown';
    if (normalized.source === 'provider_reported') normalized.reason = null;
    return normalized;
  }
  async finish(id: string, outcome: Exclude<RunOutcome, 'queued' | 'running'>, usage = unknownUsage()) { return this.complete(id, outcome, usage); }
  private complete(id: string, outcome: Exclude<RunOutcome, 'queued' | 'running'>, usage: ProviderUsage, recovered = false) {
    const run = this.get(id); if (run.after) return run;
    const normalized = this.normalizeUsage(usage);
    const timing = this.clock.get(id), resources = this.resources();
    run.durationMs = !recovered && timing?.started !== undefined ? Math.max(0, performance.now() - timing.started) : null;
    if (recovered) run.queueDurationMs = null;
    run.usage = normalized; run.outcome = outcome;
    if (!recovered && run.before && resources.processInstanceId === run.before.resources.processInstanceId) run.resourceDelta = { scope: 'worker_process_between_snapshots', cpuUserMicros: Math.max(0, resources.cpuUserMicros - run.before.resources.cpuUserMicros), cpuSystemMicros: Math.max(0, resources.cpuSystemMicros - run.before.resources.cpuSystemMicros) };
    this.transaction(() => {
      this.db.prepare('UPDATE worker_runs SET finished=1,reported=?,input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cost_usd=?,duration_ms=?,cpu_user=?,cpu_system=?,rss_bytes=? WHERE id=?').run(normalized.source === 'provider_reported' ? 1 : 0, normalized.inputTokens, normalized.outputTokens, normalized.cacheReadTokens, normalized.cacheWriteTokens, normalized.providerReportedCostUsd, run.durationMs, run.resourceDelta.cpuUserMicros, run.resourceDelta.cpuSystemMicros, Math.max(resources.rssBytes, run.before?.resources.rssBytes ?? 0), id);
      run.after = { measurement: recovered ? 'recovery' : run.before ? 'execution_boundary' : 'cancellation', capturedAt: new Date().toISOString(), state: outcome, resources, consumption: this.consumption() }; this.save(run);
    });
    this.clock.delete(id); return run;
  }
  get(id: string): WorkerRun {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new DomainError('invalid_input', 'Choose a valid run ID.');
    const row = this.db.prepare('SELECT payload FROM worker_runs WHERE id=?').get(id);
    if (!row) throw new DomainError('not_found', 'Run evidence not found.'); return JSON.parse(String(row.payload));
  }
  reserveUnknown(id: string, reason: UnknownExecutionReason): void {
    if (reason !== 'outcome_unknown' && reason !== 'process_stop_unconfirmed' && reason !== 'worker_restarted') throw new DomainError('invalid_input', 'Choose an exact unresolved execution reason.');
    const run = this.get(id);
    if (run.executionRecovery?.state === 'unknown') return;
    if (!run.startedAt || run.after || run.executionRecovery) throw new DomainError('conflict', 'Only a started unresolved attempt can reserve execution capacity.');
    run.executionRecovery = { schemaVersion: 1, revision: 1, state: 'unknown', reason, detectedAt: new Date().toISOString() };
    this.transaction(() => this.save(run));
  }
  uncertainExecutions(): WorkerRun[] {
    return this.db.prepare("SELECT payload FROM worker_runs WHERE json_extract(payload, '$.executionRecovery.state')='unknown' ORDER BY sequence").all().map(row => JSON.parse(String(row.payload)) as WorkerRun);
  }
  recoveryReplay(input: unknown): WorkerRun | undefined {
    const command = validateExecutionRecoveryCommand(input), digest = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const row = this.db.prepare('SELECT run_id,command_digest FROM execution_recovery_operations WHERE operation_id=?').get(command.operationId);
    if (!row) return undefined;
    if (row.command_digest !== digest || row.run_id !== command.runId) throw new DomainError('conflict', 'Recovery operation identity already belongs to a different attestation.');
    return this.get(command.runId);
  }
  confirmExecutionStopped(input: unknown, observation: ExecutionStopObservation): WorkerRun {
    const command = validateExecutionRecoveryCommand(input), replay = this.recoveryReplay(command);
    if (replay) return replay;
    const run = this.get(command.runId);
    assertExecutionStopObservation(run, command, observation);
    run.executionRecovery = { ...run.executionRecovery!, revision: command.expectedRevision + 1, state: 'operator_confirmed_stopped',
      confirmation: { operationId: command.operationId, note: command.note, observedAt: observation.observedAt, confirmedAt: new Date().toISOString(), basis: 'operator_attested' } };
    this.transaction(() => {
      this.save(run);
      this.db.prepare('INSERT INTO execution_recovery_operations(operation_id,run_id,command_digest) VALUES (?,?,?)').run(command.operationId, command.runId, createHash('sha256').update(JSON.stringify(command)).digest('hex'));
    });
    // Accounting may have failed after dispatch. Cessation is an explicit operator observation, never a fabricated provider result.
    return run.after ? run : this.complete(run.id, 'interrupted', run.usage, true);
  }
  latest(sessionId: string): WorkerRun | undefined {
    const row = this.db.prepare('SELECT payload FROM worker_runs WHERE session_id=? ORDER BY sequence DESC LIMIT 1').get(sessionId);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  private filter(query: RunQuery) {
    const values: (string | number)[] = [], clauses: string[] = [];
    for (const [key, column] of Object.entries({ sessionId: 'session_id', taskId: 'task_id', provider: 'provider', kind: 'kind', outcome: 'outcome' })) {
      const value = query[key as keyof RunQuery]; if (value === undefined) continue;
      if (typeof value !== 'string' || !value || value.length > 200) throw new DomainError('invalid_input', `Invalid ${key} filter.`);
      if (key === 'kind' && !['chat', 'local', 'orchestrator'].includes(value) || key === 'outcome' && !outcomes.includes(value as RunOutcome)) throw new DomainError('invalid_input', `Invalid ${key} filter.`);
      clauses.push(`${column}=?`); values.push(value);
    }
    if (query.purpose !== undefined) {
      if (!['execution', 'gate_review', 'rework'].includes(query.purpose)) throw new DomainError('invalid_input', 'Invalid purpose filter.');
      clauses.push("COALESCE(json_extract(payload, '$.purpose'), 'execution')=?"); values.push(query.purpose);
    }
    for (const key of ['since', 'until'] as const) if (query[key] !== undefined) {
      const value = query[key]; if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new DomainError('invalid_input', `Invalid ${key}; use an ISO timestamp.`);
      clauses.push('created_at' + (key === 'since' ? '>=' : '<=') + '?'); values.push(new Date(value).toISOString());
    }
    if (query.since && query.until && Date.parse(query.since) > Date.parse(query.until)) throw new DomainError('invalid_input', 'since must be before until.');
    const asOf = query.asOf ?? Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS maximum FROM worker_runs').get()!.maximum);
    if (!Number.isSafeInteger(asOf) || asOf < 0) throw new DomainError('invalid_input', 'Invalid evidence boundary.');
    clauses.push('sequence<=?'); values.push(asOf); return { where: clauses.join(' AND '), values, asOf };
  }
  list(query: RunQuery = {}): RunPage {
    const limit = query.limit ?? 50, offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new DomainError('invalid_input', 'Use limit 1–100 and a nonnegative offset.');
    let after = 0;
    const filters = createHash('sha256').update(JSON.stringify(Object.fromEntries(['sessionId','taskId','provider','kind','outcome','since','until', ...(query.purpose === undefined ? [] : ['purpose'])].map(key => [key, query[key as keyof RunQuery] ?? null])))).digest('hex');
    if (query.cursor !== undefined) {
      if (query.offset !== undefined || query.asOf !== undefined) throw new DomainError('invalid_input', 'Use cursor without offset or asOf.');
      try { if (typeof query.cursor !== 'string' || query.cursor.length > 2048) throw Error(); const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()); if (value.filters !== filters || !Number.isSafeInteger(value.after) || value.after < 0 || !Number.isSafeInteger(value.asOf) || value.asOf < value.after) throw Error(); after = value.after; query = { ...query, asOf: value.asOf }; }
      catch { throw new DomainError('invalid_input', 'Invalid run cursor.'); }
    }
    const { where, values, asOf } = this.filter(query);
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM worker_runs WHERE ${where}`).get(...values)!.count);
    const records = this.db.prepare(`SELECT payload FROM worker_runs WHERE ${where} AND sequence>? ORDER BY sequence ASC LIMIT ? OFFSET ?`).all(...values, after, limit + 1, query.cursor ? 0 : offset);
    const rows = records.slice(0, limit).map(row => JSON.parse(String(row.payload)) as WorkerRun), more = records.length > limit;
    return { schemaVersion: 1, rows, total, nextOffset: more ? offset + limit : null, nextCursor: more ? Buffer.from(JSON.stringify({ asOf, after: rows.at(-1)!.sequence, filters })).toString('base64url') : null, asOf, scope: 'worker_session_executions' };
  }
  analyze(query: RunQuery = {}): RunAnalysis {
    if (query.cursor !== undefined) throw new DomainError('invalid_input', 'Use asOf, not cursor, for analysis.');
    const { where, values, asOf } = this.filter(query), outcomes: Record<string, number> = {};
    for (const row of this.db.prepare(`SELECT outcome,COUNT(*) AS count FROM worker_runs WHERE ${where} GROUP BY outcome`).all(...values)) outcomes[String(row.outcome)] = Number(row.count);
    const rootWindow = "json_extract(payload,'$.parentRunId') IS NULL";
    const row = this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN finished=1 AND json_extract(payload,'$.before') IS NOT NULL THEN 1 ELSE 0 END),0) AS completed,COUNT(duration_ms) AS measured,SUM(duration_ms) AS duration,AVG(duration_ms) AS mean,COUNT(CASE WHEN ${rootWindow} THEN cpu_user END) AS cpuMeasured,SUM(CASE WHEN ${rootWindow} THEN cpu_user END) AS cpuUser,SUM(CASE WHEN ${rootWindow} THEN cpu_system END) AS cpuSystem,MAX(rss_bytes) AS rss FROM worker_runs WHERE ${where}`).get(...values)!;
    const number = (key: string) => row[key] === null ? null : Number(row[key]);
    return { schemaVersion: 1, scope: 'worker_session_executions', asOf, total: Number(row.total), completedPairs: Number(row.completed), outcomes, consumption: this.consumption(where, values), duration: { measuredRuns: Number(row.measured), totalMs: number('duration'), meanMs: number('mean') }, resources: { scope: 'worker_process_between_snapshots', measuredRuns: Number(row.cpuMeasured), cpuUserMicros: number('cpuUser'), cpuSystemMicros: number('cpuSystem'), peakObservedRssBytes: number('rss') }, notes: ['Only worker session executions are included; orchestrator lease snapshots remain separate.', 'Token totals sum known provider measurements; reported USD values may be client estimates or have unknown historical basis, not billed charges. Null means unavailable. Cache tokens are subsets of input tokens, not additional usage.', 'CPU is the worker Node process between execution snapshots, not the provider subprocess or host. Delegated child windows are excluded from aggregate CPU because they overlap their parent. RSS is an observed gauge, not allocated memory or provider process usage.', 'History is durable without automatic eviction. Export pages using nextCursor to exclude newly added runs; already admitted running records may advance state during export.'] };
  }
}
