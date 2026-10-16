import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../../shared/errors.js';
import { openPrivateJournal } from './database.js';
import type { InteractionAdmission, InteractionEvent, InteractionEventPage, InteractionEventType, InteractionPhase, InteractionStore, InteractionTurn, InteractionTurnSummary, InteractionView, PendingInteraction } from '../../application/interactions.js';
import type { ModelRequest, ModelResult } from '../../application/model-contract.js';
import type { ProviderUsage } from '../../application/run-evidence.js';

const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const invalid = (message: string): never => { throw new DomainError('invalid_input', message); };
const conflict = (message: string): never => { throw new DomainError('conflict', message); };
function summary(turn: InteractionTurn): InteractionTurnSummary {
  const { id, runId, kind, status, createdAt, finishedAt, priorTurnId } = turn;
  return { id, runId, kind, status, createdAt, finishedAt, priorTurnId };
}

/** Private model context; numeric run exports never read this content. */
export class WorkerInteractionJournal implements InteractionStore {
  private directory: string;
  private db?: DatabaseSync;
  constructor(directory: string) { this.directory = directory; }

  async init() {
    if (this.db) return;
    this.db = await openPrivateJournal(this.directory, 'worker-interactions.sqlite', 'Interaction storage must be a regular file.');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS interaction_sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, phase TEXT NOT NULL, pending TEXT);
        CREATE TABLE IF NOT EXISTS interaction_turns (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, run_id TEXT UNIQUE, status TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS interaction_turns_session ON interaction_turns(session_id, sequence);
        CREATE TABLE IF NOT EXISTS interaction_operations (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(session_id,operation_id));
        CREATE TABLE IF NOT EXISTS interaction_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS interaction_events_session ON interaction_events(session_id,sequence);`);
      for (const row of this.db.prepare("SELECT session_id,id FROM interaction_turns WHERE status IN ('queued','running')").all()) {
        this.fail(String(row.session_id), String(row.id), 'interrupted', 'worker_restarted');
      }
    } catch (error) { this.close(); throw error; }
  }

  close() { this.db?.close(); this.db = undefined; }
  private database() { if (!this.db) throw Error('Interaction database is not open.'); return this.db; }
  private transaction<T>(work: () => T): T {
    const db = this.database(); db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  private save(turn: InteractionTurn) {
    const payload = JSON.stringify(turn);
    if (Buffer.byteLength(payload) > 1048576) invalid('This interaction exceeds the private storage limit.');
    this.database().prepare('UPDATE interaction_turns SET run_id=?,status=?,payload=? WHERE id=?').run(turn.runId, turn.status, payload, turn.id);
  }
  private state(sessionId: string, phase: InteractionPhase, pending: PendingInteraction | null = null) {
    this.database().prepare('UPDATE interaction_sessions SET revision=revision+1,phase=?,pending=? WHERE id=?').run(phase, pending ? JSON.stringify(pending) : null, sessionId);
  }

  view(sessionId: string): InteractionView {
    if (!identifier(sessionId)) invalid('Choose a valid session ID.');
    const db = this.database(), row = db.prepare('SELECT * FROM interaction_sessions WHERE id=?').get(sessionId);
    const turns = db.prepare('SELECT payload FROM interaction_turns WHERE session_id=? ORDER BY sequence DESC LIMIT 100').all(sessionId).map(row => summary(JSON.parse(String(row.payload))));
    const totalTurns = Number(db.prepare('SELECT COUNT(*) AS count FROM interaction_turns WHERE session_id=?').get(sessionId)!.count);
    return { schemaVersion: 1, sessionId, revision: Number(row?.revision ?? 0), phase: (row?.phase ?? 'idle') as InteractionPhase, pending: row?.pending ? JSON.parse(String(row.pending)) : null, latestTurn: turns[0] ?? null, turns, totalTurns };
  }

  turn(sessionId: string, turnId: string): InteractionTurn {
    if (!identifier(sessionId) || !identifier(turnId)) invalid('Choose valid session and turn IDs.');
    const row = this.database().prepare('SELECT payload FROM interaction_turns WHERE session_id=? AND id=?').get(sessionId, turnId);
    if (!row) throw new DomainError('not_found', 'Interaction turn not found.');
    return JSON.parse(String(row.payload));
  }

  /** Resolve an acknowledged operation before routing its replay to the owning executor. */
  operation(sessionId: string, operationId: string): InteractionTurn | undefined {
    if (!identifier(sessionId) || !identifier(operationId)) invalid('Choose valid session and operation IDs.');
    const row = this.database().prepare('SELECT turn_id FROM interaction_operations WHERE session_id=? AND operation_id=?').get(sessionId, operationId);
    return row ? this.turn(sessionId, String(row.turn_id)) : undefined;
  }

  accept(input: InteractionAdmission) {
    if (!identifier(input.sessionId) || !identifier(input.operationId)) invalid('Use a session and operation ID containing 1–100 letters, digits, underscores or hyphens.');
    if (!['message', 'answer', 'resume'].includes(input.kind) || typeof input.input !== 'string' || input.input.length > 8000 || (input.kind !== 'resume' && !input.input.trim())) invalid('Provide an interaction message of 1–8,000 characters.');
    const normalized = { sessionId: input.sessionId, kind: input.kind, operationId: input.operationId, expectedRevision: input.expectedRevision ?? null, pendingId: input.pendingId ?? null, priorTurnId: input.priorTurnId ?? null, input: input.input.trim() };
    const fingerprint = digest(normalized);
    return this.transaction(() => {
      const db = this.database();
      const previous = db.prepare('SELECT digest,turn_id FROM interaction_operations WHERE session_id=? AND operation_id=?').get(input.sessionId, input.operationId);
      if (previous) {
        if (previous.digest !== fingerprint) conflict('This operation ID was already used for different input.');
        return { turn: this.turn(input.sessionId, String(previous.turn_id)), duplicate: true, view: this.view(input.sessionId) };
      }
      const view = this.view(input.sessionId);
      if (['queued', 'running'].includes(view.phase)) conflict('This session already has an active interaction.');
      if (input.kind !== 'message' && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 0)) invalid('Provide the interaction revision before answering or resuming.');
      if (input.expectedRevision !== undefined && input.expectedRevision !== view.revision) conflict('This interaction changed. Refresh before continuing.');
      let priorTurnId: string | null = null;
      if (input.kind === 'answer') {
        if (!view.pending || view.pending.id !== input.pendingId) conflict('This question is no longer waiting for an answer.');
        priorTurnId = view.pending!.turnId;
      } else if (input.kind === 'resume') {
        if (view.pending) conflict('Answer the pending question before resuming.');
        if (!input.priorTurnId || view.latestTurn?.id !== input.priorTurnId) conflict('Resume the latest stopped attempt.');
        const previousTurn = this.turn(input.sessionId, input.priorTurnId!);
        if (!['failed', 'cancelled', 'interrupted'].includes(previousTurn.status) && !(view.phase === 'cancelled' && ['waiting_input', 'escalated'].includes(previousTurn.status))) conflict('Only failed, cancelled or interrupted attempts can be resumed.');
        priorTurnId = previousTurn.id;
      } else if (view.pending) conflict('Answer the pending question before sending another message.');
      const turn: InteractionTurn = { schemaVersion: 1, id: randomUUID(), sessionId: input.sessionId, runId: null, kind: input.kind, status: 'queued', createdAt: new Date().toISOString(), finishedAt: null, priorTurnId, input: normalized.input, context: clone(input.context ?? null), dispatch: null, dispatchDigest: null, result: null, usage: null, errorCode: null };
      db.prepare("INSERT OR IGNORE INTO interaction_sessions(id,revision,phase) VALUES (?,0,'idle')").run(input.sessionId);
      db.prepare('INSERT INTO interaction_turns(id,session_id,status,payload) VALUES (?,?,?,?)').run(turn.id, turn.sessionId, turn.status, '{}');
      this.save(turn);
      db.prepare('INSERT INTO interaction_operations(session_id,operation_id,digest,turn_id) VALUES (?,?,?,?)').run(input.sessionId, input.operationId, fingerprint, turn.id);
      this.state(input.sessionId, 'queued');
      this.event(turn, 'accepted');
      return { turn, duplicate: false, view: this.view(input.sessionId) };
    });
  }

  prepare(sessionId: string, turnId: string, request: ModelRequest, runId: string) {
    this.transaction(() => {
      const turn = this.turn(sessionId, turnId), fingerprint = digest(request);
      if (turn.dispatch) {
        if (turn.dispatchDigest !== fingerprint || turn.runId !== runId) conflict('The dispatched request is immutable.');
        return;
      }
      if (turn.status !== 'queued' || !identifier(runId)) conflict('This turn cannot prepare another request.');
      turn.dispatch = clone(request); turn.dispatchDigest = fingerprint; turn.runId = runId;
      this.save(turn); this.event(turn, 'prepared');
    });
  }

  start(sessionId: string, turnId: string) {
    this.transaction(() => {
      const turn = this.turn(sessionId, turnId);
      if (turn.status !== 'queued' || !turn.dispatch || !turn.runId) conflict('This turn is not prepared for execution.');
      turn.status = 'running'; this.save(turn); this.state(sessionId, 'running'); this.event(turn, 'started');
    });
  }

  complete(sessionId: string, turnId: string, result: ModelResult, usage: ProviderUsage) {
    this.transaction(() => {
      const turn = this.turn(sessionId, turnId);
      if (turn.result) {
        if (digest(turn.result) !== digest(result)) conflict('A completed interaction result is immutable.');
        return;
      }
      if (turn.status !== 'running') conflict('This turn is no longer running.');
      turn.status = result.type === 'completed' ? 'completed' : result.request.kind === 'question' ? 'waiting_input' : 'escalated';
      turn.result = clone(result); turn.usage = clone(usage); turn.finishedAt = new Date().toISOString();
      let pending: PendingInteraction | null = null;
      if (result.type === 'needs_input') {
        const { kind, message, choices, reason } = result.request;
        pending = { id: randomUUID(), turnId, kind, message, ...(choices ? { choices: clone(choices) } : {}), ...(reason ? { reason } : {}), createdAt: turn.finishedAt };
      }
      this.save(turn); this.state(sessionId, turn.status, pending);
      this.event(turn, turn.status === 'waiting_input' ? 'input_requested' : turn.status === 'escalated' ? 'escalated' : 'completed');
    });
  }

  fail(sessionId: string, turnId: string, status: 'failed' | 'cancelled' | 'interrupted', code: string) {
    this.transaction(() => {
      const turn = this.turn(sessionId, turnId);
      if (turn.result || !['queued', 'running'].includes(turn.status)) return;
      turn.status = status; turn.finishedAt = new Date().toISOString();
      turn.errorCode = /^[a-z_]{1,60}$/.test(code) ? code : 'execution_failed';
      this.save(turn); this.state(sessionId, status); this.event(turn, status);
    });
  }

  abandon(sessionId: string, expectedRevision?: number, operationId?: string, pendingId?: string) {
    this.transaction(() => {
      const db = this.database();
      const fingerprint = digest({ action: 'cancel', sessionId, expectedRevision, pendingId });
      if (operationId) {
        if (!identifier(operationId)) invalid('Choose a valid operation ID.');
        const previous = db.prepare('SELECT digest FROM interaction_operations WHERE session_id=? AND operation_id=?').get(sessionId, operationId);
        if (previous) { if (previous.digest !== fingerprint) conflict('This operation ID was already used for different input.'); return; }
      }
      const view = this.view(sessionId);
      if (expectedRevision !== undefined && expectedRevision !== view.revision) conflict('This interaction changed. Refresh before stopping.');
      if (pendingId && view.pending?.id !== pendingId) conflict('This question is no longer waiting.');
      if (view.pending) {
        if (operationId) db.prepare('INSERT INTO interaction_operations(session_id,operation_id,digest,turn_id) VALUES (?,?,?,?)').run(sessionId, operationId, fingerprint, view.pending.turnId);
        this.state(sessionId, 'cancelled');
        this.event(this.turn(sessionId, view.pending.turnId), 'pending_cancelled');
      }
    });
  }

  retainSessions(sessionIds: string[]) {
    const retained = new Set(sessionIds);
    for (const row of this.database().prepare('SELECT id FROM interaction_sessions').all()) if (!retained.has(String(row.id))) this.deleteSession(String(row.id));
  }

  deleteSession(sessionId: string) {
    this.transaction(() => {
      const db = this.database();
      db.prepare('DELETE FROM interaction_events WHERE session_id=?').run(sessionId);
      db.prepare('DELETE FROM interaction_operations WHERE session_id=?').run(sessionId);
      db.prepare('DELETE FROM interaction_turns WHERE session_id=?').run(sessionId);
      db.prepare('DELETE FROM interaction_sessions WHERE id=?').run(sessionId);
    });
  }

  private event(turn: InteractionTurn, type: InteractionEventType, usage?: ProviderUsage) {
    const db = this.database();
    const state = db.prepare('SELECT revision,phase,pending FROM interaction_sessions WHERE id=?').get(turn.sessionId)!;
    const base = { schemaVersion: 1 as const, id: randomUUID(), sequence: 0, sessionId: turn.sessionId, revision: Number(state.revision), turnId: turn.id, runId: turn.runId, at: new Date().toISOString(), phase: state.phase as InteractionPhase };
    let value: InteractionEvent;
    if (type === 'usage_observed') {
      if (!usage) throw Error('A usage event requires normalized measurements.');
      value = { ...base, type, usage };
    } else if (type === 'input_requested' || type === 'escalated') {
      const pending: PendingInteraction = JSON.parse(String(state.pending));
      value = { ...base, type, pendingId: pending.id, requestKind: pending.kind };
    } else if (type === 'failed' || type === 'interrupted') value = { ...base, type, errorCode: turn.errorCode ?? 'execution_failed' };
    else value = { ...base, type };
    const inserted = db.prepare('INSERT INTO interaction_events(id,session_id,payload) VALUES (?,?,?)').run(value.id, value.sessionId, '{}');
    value.sequence = Number(inserted.lastInsertRowid);
    db.prepare('UPDATE interaction_events SET payload=? WHERE id=?').run(JSON.stringify(value), value.id);
  }

  events(sessionId: string, after = 0, limit = 50): InteractionEventPage {
    if (!identifier(sessionId) || !Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Use a valid session, nonnegative event cursor and limit 1–100.');
    const rows = this.database().prepare('SELECT payload FROM interaction_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(sessionId, after, limit + 1);
    const events: InteractionEvent[] = rows.slice(0, limit).map(row => JSON.parse(String(row.payload)));
    return { schemaVersion: 1, sessionId, events, nextAfter: events.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  }

  observeUsage(sessionId: string, turnId: string, usage: ProviderUsage) {
    this.transaction(() => {
      const turn = this.turn(sessionId, turnId);
      if (turn.status !== 'running') return;
      const safe: ProviderUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: null, source: 'unavailable', reason: null, costBasis: 'unavailable' };
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'providerReportedCostUsd'] as const) {
        const value = usage[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (key === 'providerReportedCostUsd' ? value <= 1e9 : Number.isSafeInteger(value) && value <= 1e12)) safe[key] = value;
      }
      if ([safe.inputTokens, safe.outputTokens, safe.cacheReadTokens, safe.cacheWriteTokens, safe.providerReportedCostUsd].some(value => value !== null)) safe.source = 'provider_reported';
      if (safe.providerReportedCostUsd !== null) safe.costBasis = ['reported_estimate', 'reported_billed', 'unknown'].includes(usage.costBasis ?? '') ? usage.costBasis : 'unknown';
      if (digest(turn.usage) === digest(safe)) return;
      turn.usage = safe; this.save(turn);
      this.state(sessionId, 'running'); this.event(turn, 'usage_observed', safe);
    });
  }

  resultForRun(runId: string) {
    const row = this.database().prepare('SELECT payload FROM interaction_turns WHERE run_id=?').get(runId);
    if (!row) return;
    const turn: InteractionTurn = JSON.parse(String(row.payload));
    if (turn.result && turn.usage) return { outcome: turn.status === 'completed' && turn.dispatch?.operation === 'patch' ? 'review' as const : turn.status as 'completed' | 'waiting_input' | 'escalated', usage: turn.usage };
  }
}
