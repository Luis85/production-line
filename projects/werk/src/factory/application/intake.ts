import { identifier, object, taskInput, type TaskInput } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import type { ProductionLine, LineOverview } from '../../shared/factory.js';
import type { FactoryRegistry, LineReader } from './ports.js';
import { descendantFactories } from './overview.js';

export interface FactoryRoutingPolicy { mode: 'auto' | 'manual'; lineId: string | null; paused: boolean }
export interface IntakeTask {
  id: string; factoryId: string; task: TaskInput; lineId: string | null;
  status: 'queued' | 'delivering' | 'delivered'; reason: string;
  destination: ProductionLine | null; deliveryTask: unknown; deliveryPath: '/v1/tasks' | '/v1/iteration/tasks'; remoteTaskId: string | null; createdAt: number; updatedAt: number;
}
export interface IntakeRepository {
  policy(factoryId: string): FactoryRoutingPolicy;
  configure(factoryId: string, policy: FactoryRoutingPolicy): FactoryRoutingPolicy;
  create(factoryId: string, task: TaskInput, lineId: string | null, key: string): IntakeTask;
  list(factoryIds: string[]): { tasks: IntakeTask[]; total: number; queued: number; delivering: number; delivered: number };
  pending(): IntakeTask[];
  get(id: string): IntakeTask;
  destination(id: string, lineId: string | null): IntakeTask;
  pin(item: IntakeTask, line: ProductionLine, policy: FactoryRoutingPolicy, deliveryTask: unknown, deliveryPath: IntakeTask['deliveryPath']): IntakeTask | null;
  references(type: 'factory' | 'line', id: string): boolean;
  update(id: string, status: IntakeTask['status'], reason: string, remoteTaskId?: string): void;
}
export interface LineDelivery { send(line: ProductionLine, item: IntakeTask): Promise<string>; close(): void }

/** Durable intake routes into an independent orchestrator queue; workers retain their pull protocol. */
export class FactoryIntake {
  private readonly registry: FactoryRegistry;
  private readonly reader: LineReader;
  private readonly repository: IntakeRepository;
  private readonly delivery: LineDelivery;
  private running?: Promise<void>;
  private stopped = false;
  constructor(registry: FactoryRegistry, reader: LineReader, repository: IntakeRepository, delivery: LineDelivery) {
    this.registry = registry; this.reader = reader; this.repository = repository; this.delivery = delivery;
  }
  assertRemoval(type: 'factory' | 'line', id: string) {
    if (this.repository.references(type, id)) throw new DomainError('conflict', 'This registration owns intake history or queued work and cannot be removed');
  }
  private scope(factoryId: string) {
    this.registry.factory(factoryId);
    return new Set(descendantFactories(this.registry.factories(), factoryId).map(factory => factory.id));
  }
  policy(factoryId: string) { this.registry.factory(factoryId); return this.repository.policy(factoryId); }
  configure(factoryId: string, input: unknown) {
    const body = object(input, 'Factory routing', ['mode', 'lineId', 'paused']);
    if ((typeof body.mode !== 'string' || !['auto', 'manual'].includes(body.mode)) || typeof body.paused !== 'boolean') throw new DomainError('invalid_input', 'mode: auto|manual and paused: boolean required');
    const lineId = body.lineId == null ? null : identifier(body.lineId, 'lineId');
    const scope = this.scope(factoryId);
    if (lineId && !scope.has(this.registry.line(lineId).factoryId)) throw new DomainError('invalid_input', 'Destination must belong to this Factory scope');
    if (body.mode === 'auto' && lineId) throw new DomainError('invalid_input', 'Automatic routing does not have a fixed line');
    return this.repository.configure(factoryId, { mode: body.mode as 'auto' | 'manual', lineId, paused: body.paused });
  }
  create(input: unknown, key: string) {
    const body = object(input, 'Factory intake', ['factoryId', 'task', 'lineId']);
    const factoryId = identifier(body.factoryId, 'factoryId'), scope = this.scope(factoryId);
    const lineId = body.lineId == null ? null : identifier(body.lineId, 'lineId');
    if (lineId && !scope.has(this.registry.line(lineId).factoryId)) throw new DomainError('invalid_input', 'Destination must belong to this Factory scope');
    return this.repository.create(factoryId, taskInput(body.task), lineId, key);
  }
  list(factoryId?: string) {
    return this.repository.list(factoryId ? [...this.scope(factoryId)] : this.registry.factories().map(factory => factory.id));
  }
  route(id: string, input: unknown) {
    const body = object(input, 'Intake destination', ['lineId']);
    if (!Object.hasOwn(body, 'lineId')) throw new DomainError('invalid_input', 'lineId required; null returns to the routing policy');
    const item = this.repository.get(id), scope = this.scope(item.factoryId);
    const lineId = body.lineId === null ? null : identifier(body.lineId, 'lineId');
    if (lineId && !scope.has(this.registry.line(lineId).factoryId)) throw new DomainError('invalid_input', 'Destination must belong to this Factory scope');
    return this.repository.destination(id, lineId);
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) this.running = this.dispatch().finally(() => { this.running = undefined; });
    return this.running;
  }
  private compatible(item: IntakeTask, observation: LineOverview): boolean {
    const overview = observation.overview, capability = overview?.capabilities;
    if (observation.status !== 'available' || !overview || !capability || overview.project !== item.task.project) return false;
    if (Date.now() - Date.parse(overview.observedAt) > 60000 || Date.parse(overview.observedAt) > Date.now() + 5000) return false;
    const mode = item.task.executionMode ?? 'mock';
    if (this.repositoryCapacity(item, observation)?.length === 0) return false;
    if (!capability.profiles.some(profile => (profile.mode ?? 'mock') === mode && (item.task.provider === 'auto' || profile.provider === item.task.provider))) return false;
    return capability.intake.includes(capability.context === 'pinned' && item.task.source ? 'pinned_iteration' : item.task.requirementRef ? 'requirement_ref' : 'structured_task') && (capability.context !== 'pinned' || !!item.task.requirementRef);
  }
  private repositoryCapacity(item: IntakeTask, observation: LineOverview) {
    const mode = item.task.executionMode ?? 'mock', selector = item.task.repository ?? (mode === 'cli' ? item.task.project : undefined);
    const capacity = observation.overview?.capabilities?.repositoryCapacity;
    if (selector === undefined || capacity === undefined) return undefined;
    return capacity.filter(row => (row.repositoryId === null || row.repositoryId === selector) && (!row.implicitOnly || item.task.repository === undefined) && row.mode === mode && (item.task.provider === 'auto' || row.provider === item.task.provider));
  }
  private freeCapacity(item: IntakeTask, observation: LineOverview): number {
    const repository = this.repositoryCapacity(item, observation);
    if (repository) {
      const byProvider = new Map<string, number>();
      for (const row of repository) byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + row.slotsAvailable);
      return Math.max(0, ...byProvider.values());
    }
    return Math.max(0, ...(observation.overview?.capabilities?.eligibleCapacity ?? []).filter(row => row.mode === (item.task.executionMode ?? 'mock') && (item.task.provider === 'auto' || row.provider === item.task.provider)).map(row => row.slotsAvailable));
  }
  private async dispatch() {
    for (const original of this.repository.pending()) {
      if (this.stopped) return;
      let item = original;
      try {
        const policy = this.policy(item.factoryId);
        if (policy.paused) { this.repository.update(item.id, item.status, 'Factory routing is paused'); continue; }
        if (!item.destination) {
          const scope = this.scope(item.factoryId), fixed = item.lineId ?? (policy.mode === 'manual' ? policy.lineId : null);
          if (!fixed && policy.mode === 'manual') { this.repository.update(item.id, 'queued', 'Choose a production line'); continue; }
          const lines = this.registry.lines().filter(line => scope.has(line.factoryId) && (!fixed || line.id === fixed));
          const observations = await Promise.all(lines.map(line => this.reader.read(line)));
          const eligible = observations.filter(observation => this.compatible(item, observation) && (fixed || this.freeCapacity(item, observation) > 0));
          eligible.sort((a, b) => this.freeCapacity(item, b) - this.freeCapacity(item, a) || a.overview!.tasks.queued - b.overview!.tasks.queued || a.line.id.localeCompare(b.line.id));
          if (!eligible[0]) { this.repository.update(item.id, 'queued', fixed ? 'Selected line unavailable or incompatible with this project, provider or intake' : 'Waiting for a compatible line with observed free capacity'); continue; }
          const chosen = eligible[0], latestPolicy = this.policy(item.factoryId);
          if (!this.scope(item.factoryId).has(chosen.line.factoryId) || JSON.stringify(policy) !== JSON.stringify(latestPolicy) || JSON.stringify(this.registry.line(chosen.line.id)) !== JSON.stringify(chosen.line)) continue;
          const task = item.task;
          const payload = chosen.overview!.capabilities!.context === 'pinned' && !task.source
            ? { project: task.project, ...(task.repository === undefined ? {} : { repository: task.repository }), requirementRef: task.requirementRef, provider: task.provider, priority: task.priority, ...(task.executionMode ? { executionMode: task.executionMode } : {}) } : task;
          const pinned = this.repository.pin(item, chosen.line, policy, payload, chosen.overview!.capabilities!.context === 'pinned' && task.source ? '/v1/iteration/tasks' : '/v1/tasks');
          if (!pinned) continue;
          item = pinned;
        }
        if (this.stopped) return;
        const remoteTaskId = await this.delivery.send(item.destination!, item);
        this.repository.update(item.id, 'delivered', 'Accepted into the production-line queue', remoteTaskId);
      } catch {
        this.repository.update(item.id, item.destination ? 'delivering' : 'queued', item.destination ? 'Delivery not acknowledged; retrying the same destination and task key' : 'Factory or line unavailable; task remains queued');
      }
    }
  }
  async close() { this.stopped = true; this.delivery.close(); await this.running; }
}
