import { ageSeconds, defaultMonitoringThresholds, monitoringReport, operationalAlert, type MonitoringThresholds } from '../../shared/monitoring.js';
import { factoryInput, lineInput } from '../../shared/factory.js';
import { DomainError } from '../../shared/errors.js';
import type { FactoryOverview, LineOverview, ProductionLine } from '../../shared/factory.js';
import type { FactoryRegistry, LineReader } from './ports.js';
import { descendantFactories, overviewTotals } from './overview.js';
import { factoryPatch, linePatch, mutationKey, type MutationOperation, type MutationResult } from './mutations.js';
import { managedRegistry, assertRegistryEditable, type ManagedRegistry } from './managed-registry.js';
import { identifier } from '../../shared/contracts.js';

/** Registry commands and portfolio observation, independent of SQLite and HTTP. */
export class FactoryApplication {
    private readonly registry: FactoryRegistry;
    private removalGuard?: (type: 'factory' | 'line', id: string) => void;
    protectIntake(guard: (type: 'factory' | 'line', id: string) => void) { this.removalGuard = guard; }
    private readonly reader: LineReader;
    private readonly configuredCredentials: ReadonlySet<string>;
    private readonly now: () => number;
  private readonly monitoringConfig: MonitoringThresholds;
    private readonly managed: ManagedRegistry | undefined;

    constructor(registry: FactoryRegistry, reader: LineReader, configuredCredentials: ReadonlySet<string>, now = Date.now, monitoringConfig: MonitoringThresholds = defaultMonitoringThresholds, managed?: ManagedRegistry) {
        this.managed = managedRegistry(managed);
        this.registry = registry;
    this.monitoringConfig = monitoringConfig;
        this.reader = reader;
        this.configuredCredentials = configuredCredentials;
        this.now = now;
    }

    factories() { return { factories: this.registry.factories(), ...(this.managed ? { managedRegistry: this.managed } : {}) }; }
    factory(id: string) { return this.registry.factory(id); }
    private mutate<T extends MutationResult>(operation: MutationOperation, target: string | null, payload: unknown, key: string | undefined, action: () => T): T {
        const normalizedKey = mutationKey(key);
        return normalizedKey === undefined ? action() : this.registry.mutation({ key: normalizedKey, operation, target, payload }, action);
    }
    createFactory(input: unknown, key?: string) {
        const value = factoryInput(input);
        return this.mutate('factory.create', null, value, key, () => this.registry.createFactory(value));
    }
    updateFactory(id: string, input: unknown, key?: string) {
        id = identifier(id, 'id');
        assertRegistryEditable(this.managed, 'factories', id);
        const patch = factoryPatch(input);
        return this.mutate('factory.update', id, patch, key, () =>
            this.registry.updateFactory(id, factoryInput(patch, this.registry.factory(id))));
    }
    deleteFactory(id: string, key?: string) {
        id = identifier(id, 'id');
        assertRegistryEditable(this.managed, 'factories', id);
        return this.mutate('factory.delete', id, null, key, () => {
            this.removalGuard?.('factory', id);
            this.registry.deleteFactory(id);
            return { deleted: true as const, id };
        });
    }

    lines() { return { lines: this.registry.lines() }; }
    line(id: string) { return this.registry.line(id); }
    private requireConfiguredCredential(reference: string): void {
        if (!this.configuredCredentials.has(reference)) {
            throw new DomainError('invalid_input', 'tokenEnv must reference a configured WERK_LINE_<NAME>_TOKEN credential');
        }
    }
    createLine(input: unknown, key?: string) {
        const value = lineInput(input);
        return this.mutate('line.create', null, value, key, () => {
            this.requireConfiguredCredential(value.tokenEnv);
            return this.registry.createLine(value);
        });
    }
    updateLine(id: string, input: unknown, key?: string) {
        id = identifier(id, 'id');
        assertRegistryEditable(this.managed, 'lines', id);
        const patch = linePatch(input);
        return this.mutate('line.update', id, patch, key, () => {
            const previous = this.registry.line(id), value = lineInput(patch, previous);
            // Missing deployment credentials must not prevent renaming an existing registration.
            if (value.tokenEnv !== previous.tokenEnv) this.requireConfiguredCredential(value.tokenEnv);
            return this.registry.updateLine(id, value);
        });
    }
    deleteLine(id: string, key?: string) {
        id = identifier(id, 'id');
        assertRegistryEditable(this.managed, 'lines', id);
        return this.mutate('line.delete', id, null, key, () => {
            this.removalGuard?.('line', id);
            this.registry.deleteLine(id);
            return { deleted: true as const, id };
        });
    }

    private async observe(line: ProductionLine): Promise<LineOverview> {
        try {
            return await this.reader.read(line);
        } catch {
            // One failed integration cannot erase healthy lines or reflect adapter/credential diagnostics.
            return {
                line, status: 'unavailable', checkedAt: new Date(this.now()).toISOString(),
                error: 'Unable to read this production line; other lines remain available', overview: null,
            };
        }
    }

    async monitoring() {
        const overview = await this.overview(), now = this.now(), thresholds = this.monitoringConfig;
        const available = overview.lines.filter(line => line.status === 'available' && line.overview);
        const stale = available.filter(line => ageSeconds(now, Date.parse(line.overview!.observedAt)) >= thresholds.staleObservationSeconds).length;
        const metrics: Record<string, number> = { werk_lines_registered: overview.totals.lines, werk_lines_available: overview.totals.availableLines, werk_lines_unavailable: overview.totals.unavailableLines, werk_lines_stale: stale, werk_observation_partial: overview.totals.partial ? 1 : 0 };
        if (overview.totals.workers) { metrics.werk_workers_online = overview.totals.workers.online; metrics.werk_workers_offline = overview.totals.workers.offline; }
        if (overview.totals.tasks) { metrics.werk_tasks_queued = overview.totals.tasks.queued; metrics.werk_tasks_running = overview.totals.tasks.running; metrics.werk_tasks_blocked = overview.totals.tasks.blocked; metrics.werk_tasks_review = overview.totals.tasks.review ?? 0; }
        const alerts = [];
        if (overview.totals.unavailableLines > 0) alerts.push(operationalAlert('lines_unavailable', 'One or more registered lines cannot be observed.', 'Inspect Factory line status, endpoint connectivity and the configured line credential.', 'critical'));
        if (stale > 0) alerts.push(operationalAlert('line_observation_stale', 'A line returned an old observation.', 'Inspect the line clock and orchestrator health; treat its totals as stale.'));
        if (overview.totals.partial) alerts.push(operationalAlert('partial_observation', 'Fleet totals are incomplete.', 'Use each line directly until all line observations recover.'));
        return monitoringReport('factory', now, metrics, alerts, thresholds);
    }

    async overview(factoryId?: string): Promise<FactoryOverview> {
        if (factoryId !== undefined) this.registry.factory(factoryId);
        const factories = descendantFactories(this.registry.factories(), factoryId);
        const scope = new Set(factories.map(factory => factory.id));
        const registered = this.registry.lines().filter(line => scope.has(line.factoryId));
        const lines = await Promise.all(registered.map(line => this.observe(line)));
        return {
            factoryId: factoryId ?? null,
            observedAt: new Date(this.now()).toISOString(),
            factories,
            lines,
            totals: overviewTotals(lines),
        };
    }
}
