import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import type { TaskInput } from '../../shared/contracts.js';
import type { ProductionLine } from '../../shared/factory.js';
import type { FactoryRoutingPolicy, IntakeRepository, IntakeTask } from '../application/intake.js';

/** This private outbox is separate from the registry and never opens a line database. */
export class SqliteIntakeStore implements IntakeRepository {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS intake(id TEXT PRIMARY KEY,factory TEXT NOT NULL,idem TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS intake_pending ON intake(status,updated);
      CREATE TABLE IF NOT EXISTS policy(factory TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  policy(factoryId: string): FactoryRoutingPolicy {
    const row = this.db.prepare('SELECT payload FROM policy WHERE factory=?').get(factoryId);
    return row ? JSON.parse(String(row.payload)) : { mode: 'auto', lineId: null, paused: false };
  }
  configure(factoryId: string, policy: FactoryRoutingPolicy) {
    this.db.prepare('INSERT INTO policy VALUES(?,?) ON CONFLICT(factory) DO UPDATE SET payload=excluded.payload').run(factoryId, JSON.stringify(policy)); return policy;
  }
  create(factoryId: string, task: TaskInput, lineId: string | null, key: string): IntakeTask {
    if (!/^[\w:.-]{1,128}$/.test(key)) throw new DomainError('invalid_input', 'A valid Idempotency-Key is required');
    const digest = createHash('sha256').update(JSON.stringify({ factoryId, task, lineId })).digest('hex');
    const item: IntakeTask = { id: randomUUID(), factoryId, task, lineId, status: 'queued', reason: 'Waiting for routing', destination: null, deliveryTask: null, deliveryPath: '/v1/tasks', remoteTaskId: null, createdAt: Date.now(), updatedAt: Date.now() };
    this.db.prepare('INSERT INTO intake VALUES(?,?,?,?,?,?,?) ON CONFLICT(idem) DO NOTHING').run(item.id, factoryId, key, digest, JSON.stringify(item), item.status, item.updatedAt);
    const row = this.db.prepare('SELECT * FROM intake WHERE idem=?').get(key)!;
    if (row.digest !== digest) throw new DomainError('conflict', 'Idempotency key already used for different intake');
    return JSON.parse(String(row.payload));
  }
  list(factoryIds: string[]) {
    const scope = JSON.stringify(factoryIds), counts = { total: 0, queued: 0, delivering: 0, delivered: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM intake WHERE factory IN (SELECT value FROM json_each(?)) GROUP BY status').all(scope)) { counts[row.status as 'queued' | 'delivering' | 'delivered'] = Number(row.count); counts.total += Number(row.count); }
    const tasks = this.db.prepare('SELECT payload FROM intake WHERE factory IN (SELECT value FROM json_each(?)) ORDER BY updated DESC,id LIMIT 100').all(scope).map(row => JSON.parse(String(row.payload)) as IntakeTask);
    return { tasks, ...counts };
  }
  pending(): IntakeTask[] { return this.db.prepare("SELECT payload FROM intake WHERE status<>'delivered' ORDER BY updated,id LIMIT 100").all().map(row => JSON.parse(String(row.payload))); }
  get(id: string): IntakeTask { const row = this.db.prepare('SELECT payload FROM intake WHERE id=?').get(id); if (!row) throw new DomainError('not_found', 'Intake task not found'); return JSON.parse(String(row.payload)); }
  private change(id: string, action: (item: IntakeTask) => void): IntakeTask {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const item = this.get(id); action(item); item.updatedAt = Date.now();
      this.db.prepare('UPDATE intake SET payload=?,status=?,updated=? WHERE id=?').run(JSON.stringify(item), item.status, item.updatedAt, id);
      this.db.exec('COMMIT'); return item;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  destination(id: string, lineId: string | null) { return this.change(id, item => {
    if (item.destination || item.status !== 'queued') throw new DomainError('conflict', 'Delivery has started; destination is fixed to prevent duplicate work');
    item.lineId = lineId; item.reason = 'Waiting for routing';
  }); }
  references(type: 'factory' | 'line', id: string): boolean {
    return !!(type === 'factory'
      ? this.db.prepare('SELECT id FROM intake WHERE factory=? LIMIT 1').get(id)
      : this.db.prepare("SELECT id FROM intake WHERE json_extract(payload,'$.lineId')=? OR json_extract(payload,'$.destination.id')=? LIMIT 1").get(id, id));
  }
  pin(expected: IntakeTask, line: ProductionLine, policy: FactoryRoutingPolicy, deliveryTask: unknown, deliveryPath: IntakeTask['deliveryPath']): IntakeTask | null {
    let accepted = false;
    const updated = this.change(expected.id, item => {
      if (JSON.stringify(item) !== JSON.stringify(expected) || JSON.stringify(this.policy(item.factoryId)) !== JSON.stringify(policy)) return;
      if (item.destination || item.status !== 'queued') return;
      item.destination = line; item.deliveryTask = deliveryTask; item.deliveryPath = deliveryPath; item.status = 'delivering'; item.reason = 'Sending to the production-line queue'; accepted = true;
    });
    return accepted ? updated : null;
  }
  update(id: string, status: IntakeTask['status'], reason: string, remoteTaskId?: string) {
    this.change(id, item => { if (item.status === 'delivered') return; item.status = status; item.reason = reason; if (remoteTaskId) item.remoteTaskId = remoteTaskId; });
  }
}
