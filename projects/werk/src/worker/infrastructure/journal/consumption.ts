import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../shared/errors.js';
import { measuredConsumption, type ConsumptionLedger, type ConsumptionRecord, type ConsumptionSummary, type ConsumptionWindow } from '../../application/consumption.js';
import { unknownUsage } from '../../application/run-evidence.js';
import { openPrivateJournal } from './database.js';

/** Durable invocation accounting is independent of session retention, provider settings and policy revisions. */
export class WorkerConsumptionJournal implements ConsumptionLedger {
  private directory: string;
  private db!: DatabaseSync;
  private initialized = false;
  constructor(directory: string) { this.directory = directory; }
  async init(): Promise<void> {
    if (this.initialized) return;
    this.db = await openPrivateJournal(this.directory, 'worker-consumption.sqlite', 'Consumption storage must be a regular file, not a symlink.');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS consumption_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS consumption_invocations (
          id TEXT PRIMARY KEY, provider TEXT NOT NULL, started_at TEXT NOT NULL, state TEXT NOT NULL,
          reserved_tokens INTEGER NOT NULL, measured_tokens INTEGER NOT NULL, charged_tokens INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS consumption_invocations_window ON consumption_invocations(started_at);`);
      this.transaction(() => {
        this.db.prepare('INSERT OR IGNORE INTO consumption_metadata(key,value) VALUES (?,?)').run('tracking_started_at', new Date().toISOString());
        // A process interruption cannot prove final usage, even if an intermediate observation exists.
        for (const row of this.db.prepare("SELECT payload FROM consumption_invocations WHERE state='active'").all()) {
          const record = JSON.parse(String(row.payload)) as ConsumptionRecord;
          record.state = 'uncertain'; this.save(record);
        }
      });
      this.initialized = true;
    } catch (error) { try { this.db.close(); } catch { /* Preserve the initialization failure. */ } throw error; }
  }
  close(): void { if (this.initialized) { this.db.close(); this.initialized = false; } }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original storage error. */ } throw error; }
  }
  summary(window: ConsumptionWindow): ConsumptionSummary {
    const row = this.db.prepare(`SELECT
      COALESCE(SUM(measured_tokens),0) AS measured,
      COALESCE(SUM(CASE WHEN state IN ('active','uncertain') THEN MAX(0, reserved_tokens-measured_tokens) ELSE 0 END),0) AS reserved,
      COALESCE(SUM(charged_tokens),0) AS charged,
      COALESCE(SUM(CASE WHEN state='active' THEN 1 ELSE 0 END),0) AS active,
      COALESCE(SUM(CASE WHEN state='uncertain' THEN 1 ELSE 0 END),0) AS uncertain
      FROM consumption_invocations WHERE started_at>=? AND started_at<? AND state!='released'`).get(window.periodStart, window.periodEnd)!;
    const tracking = this.db.prepare('SELECT value FROM consumption_metadata WHERE key=?').get('tracking_started_at');
    if (!tracking) throw Error('Consumption tracking metadata is missing.');
    for (const value of [row.measured, row.reserved, row.charged, row.active, row.uncertain]) {
      if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error('Consumption totals exceed safe accounting bounds.');
    }
    return { trackingStartedAt: String(tracking.value), measuredTokens: Number(row.measured), reservedTokens: Number(row.reserved), chargedTokens: Number(row.charged), activeInvocations: Number(row.active), uncertainInvocations: Number(row.uncertain) };
  }
  create(provider: string, startedAt: string, reservedTokens: number): ConsumptionRecord {
    const record: ConsumptionRecord = { id: randomUUID(), provider, startedAt, reservedTokens, state: 'active', usage: unknownUsage() };
    this.db.prepare('INSERT INTO consumption_invocations(id,provider,started_at,state,reserved_tokens,measured_tokens,charged_tokens,payload) VALUES (?,?,?,?,?,?,?,?)').run(record.id, provider, startedAt, record.state, reservedTokens, 0, reservedTokens, JSON.stringify(record));
    return record;
  }
  get(id: string): ConsumptionRecord {
    const row = this.db.prepare('SELECT payload FROM consumption_invocations WHERE id=?').get(id);
    if (!row) throw new DomainError('not_found', 'Consumption invocation not found.');
    return JSON.parse(String(row.payload)) as ConsumptionRecord;
  }
  save(record: ConsumptionRecord): void {
    const measured = measuredConsumption(record.usage);
    const charged = record.state === 'released' ? 0 : record.state === 'complete' ? measured : Math.max(record.reservedTokens, measured);
    this.db.prepare('UPDATE consumption_invocations SET state=?,measured_tokens=?,charged_tokens=?,payload=? WHERE id=?').run(record.state, measured, charged, JSON.stringify(record), record.id);
  }
}
