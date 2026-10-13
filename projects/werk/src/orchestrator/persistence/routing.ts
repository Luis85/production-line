import type { DatabaseSync } from 'node:sqlite';
import { identifier, object } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import type { Task } from '../../shared/contracts.js';
import type { WorkerRecord } from '../../shared/protocol.js';
import { eligibleProfile } from '../policies.js';

export interface RoutingPolicy { mode: 'auto' | 'manual'; workerId: string | null; order: 'worker' | 'priority' | 'fifo' }
const defaults: RoutingPolicy = { mode: 'auto', workerId: null, order: 'worker' };
export class WorkerRouter {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  policy(project: string): RoutingPolicy {
    const row = this.db.prepare('SELECT payload FROM routing_policy WHERE project=?').get(project);
    return row ? JSON.parse(String(row.payload)) : { ...defaults };
  }
  configure(project: string, input: unknown): RoutingPolicy {
    const body = object(input, 'Routing policy', ['mode', 'workerId', 'order']);
    if (typeof body.mode !== 'string' || !['auto', 'manual'].includes(body.mode) || typeof body.order !== 'string' || !['worker', 'priority', 'fifo'].includes(body.order)) throw new DomainError('invalid_input', 'mode: auto|manual; order: worker|priority|fifo');
    const workerId = body.workerId == null ? null : this.destination(project, body.workerId);
    if (body.mode === 'auto' && workerId) throw new DomainError('invalid_input', 'Automatic routing does not have a fixed worker');
    const policy = { mode: body.mode, workerId, order: body.order } as RoutingPolicy;
    this.db.prepare('INSERT INTO routing_policy VALUES(?,?) ON CONFLICT(project) DO UPDATE SET payload=excluded.payload').run(project, JSON.stringify(policy));
    return policy;
  }
  private destination(project: string, value: unknown): string {
    const id = identifier(value, 'workerId');
    if (!this.db.prepare('SELECT id FROM workers WHERE id=? AND project=?').get(id, project)) throw new DomainError('invalid_input', 'Destination must be a registered worker in this project');
    return id;
  }
  assign(task: Task, input: unknown) {
    if (task.status !== 'queued') throw new DomainError('conflict', 'Only queued tasks can change destination');
    const body = object(input, 'Task destination', ['workerId']);
    if (!Object.hasOwn(body, 'workerId')) throw new DomainError('invalid_input', 'workerId required; null returns to the routing policy');
    const workerId = body.workerId === null ? null : this.destination(task.project, body.workerId);
    if (workerId === null) this.db.prepare('DELETE FROM task_routing WHERE task=?').run(task.id);
    else this.db.prepare('INSERT INTO task_routing VALUES(?,?) ON CONFLICT(task) DO UPDATE SET worker=excluded.worker').run(task.id, workerId);
    return { taskId: task.id, workerId };
  }
  target(task: Task, policy: RoutingPolicy): string | null {
    return (this.db.prepare('SELECT worker FROM task_routing WHERE task=?').get(task.id)?.worker as string | undefined) ?? (policy.mode === 'manual' ? policy.workerId : null);
  }
  permits(task: Task, claimant: WorkerRecord, candidates: readonly { worker: WorkerRecord; active: Task[] }[], policy: RoutingPolicy): boolean {
    const fixed = this.target(task, policy);
    if (fixed) return fixed === claimant.id;
    if (policy.mode === 'manual') return false;
    const load = (entry: { worker: WorkerRecord; active: Task[] }) => entry.active.length / Math.max(1, Math.min(entry.worker.config.maxParallel, entry.worker.profiles.reduce((sum, p) => sum + (p.maxParallel ?? 1), 0)));
    const eligible = candidates.filter(entry => eligibleProfile(entry.worker, task, entry.active));
    const current = eligible.find(entry => entry.worker.id === claimant.id);
    return !!current && !eligible.some(entry => load(entry) < load(current));
  }
}
