import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../shared/errors.js';
import { openPrivateJournal } from './database.js';
import type { ResourceAlert, ResourceEvent, ResourceEventPage, ResourceEventStore } from '../../application/resources.js';

/** Durable worker-wide numeric warning transitions, bounded independently from run evidence. */
export class WorkerResourceJournal implements ResourceEventStore {
  private directory: string;
  private db?: DatabaseSync;
  constructor(directory: string) { this.directory = directory; }
  async init() {
    if (this.db) return;
    this.db = await openPrivateJournal(this.directory, 'worker-resources.sqlite', 'Resource journal must be a regular file.');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS resource_alerts (code TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resource_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);`);
    } catch (error) { this.close(); throw error; }
  }
  private database() { if (!this.db) throw Error('Resource journal is not open.'); return this.db; }
  active(): ResourceAlert[] { return this.database().prepare('SELECT payload FROM resource_alerts ORDER BY code').all().map(row => JSON.parse(String(row.payload))); }
  transition(alert: ResourceAlert, type: ResourceEvent['type'], reason: ResourceEvent['reason'], at: string) {
    const db = this.database(); db.exec('BEGIN IMMEDIATE');
    try {
      if (type === 'opened') db.prepare('INSERT INTO resource_alerts(code,payload) VALUES (?,?)').run(alert.code, JSON.stringify(alert));
      else db.prepare('DELETE FROM resource_alerts WHERE code=?').run(alert.code);
      const event: Omit<ResourceEvent, 'sequence'> = { schemaVersion: 1, id: randomUUID(), alertId: alert.id, code: alert.code, type, at, reason, observed: alert.observed, threshold: alert.threshold, ...(alert.sessionId ? { sessionId: alert.sessionId } : {}) };
      db.prepare('INSERT INTO resource_events(payload) VALUES (?)').run(JSON.stringify(event));
      db.exec('DELETE FROM resource_events WHERE sequence NOT IN (SELECT sequence FROM resource_events ORDER BY sequence DESC LIMIT 1000)');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  events(after = 0, limit = 50): ResourceEventPage {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError('invalid_input', 'Resource event cursor must be a nonnegative integer; limit must be 1–100.');
    const db = this.database();
    const rows = db.prepare('SELECT sequence,payload FROM resource_events WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit + 1);
    const events: ResourceEvent[] = rows.slice(0, limit).map(row => ({ ...JSON.parse(String(row.payload)), sequence: Number(row.sequence) }));
    const oldest = db.prepare('SELECT MIN(sequence) AS oldest FROM resource_events').get()?.oldest;
    const oldestAvailableSequence = oldest === null || oldest === undefined ? null : Number(oldest);
    return { schemaVersion: 1, events, nextAfter: events.at(-1)?.sequence ?? after, hasMore: rows.length > limit, oldestAvailableSequence, gap: oldestAvailableSequence !== null && after < oldestAvailableSequence - 1 };
  }
  close() { this.db?.close(); this.db = undefined; }
}
