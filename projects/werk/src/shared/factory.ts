import { validateLineCapabilities, type LineCapabilities } from './capabilities.js';
import { identifier, object, text } from './contracts.js';
import { ValidationError } from './errors.js';
export interface Factory {
    id: string;
    name: string;
    parentId: string | null;
}
export interface ProductionLine {
    id: string;
    name: string;
    factoryId: string;
    orchestratorUrl: string;
    webviewUrl: string;
    tokenEnv: string;
}
export interface TaskCounts {
    total: number;
    queued: number;
    running: number;
    simulated: number;
    review?: number;
    blocked: number;
}
export interface WorkerCounts {
    total: number;
    online: number;
    offline: number;
    slotsTotal: number;
    slotsBusy: number;
    slotsAvailable: number;
}
export interface SnapshotCounts {
    total: number;
    before: number;
    after: number;
}
export interface OrchestratorOverview {
    capabilities?: LineCapabilities | null;
    schemaVersion: 1;
    observedAt: string;
    mode: 'mock' | 'cli' | 'mixed';
    project: string;
    tasks: TaskCounts;
    workers: WorkerCounts;
    snapshots: SnapshotCounts;
    cost: {
        amountUsd: null;
        reason: string;
    };
}
export interface LineOverview {
    line: ProductionLine;
    status: 'available' | 'unavailable' | 'unauthorized' | 'unconfigured' | 'invalid';
    checkedAt: string;
    error: string | null;
    overview: OrchestratorOverview | null;
}
export interface FactoryOverview {
    factoryId: string | null;
    observedAt: string;
    factories: Factory[];
    lines: LineOverview[];
    totals: {
        lines: number;
        availableLines: number;
        unavailableLines: number;
        partial: boolean;
        tasks: TaskCounts | null;
        workers: WorkerCounts | null;
        snapshots: SnapshotCounts | null;
        cost: {
            amountUsd: null;
            reason: string;
        };
    };
}
export const LINE_TOKEN_PATTERN = /^WERK_LINE_[A-Z0-9_]+_TOKEN$/;
export function factoryInput(value: unknown, previous?: Factory): Omit<Factory, 'id'> & {
    id?: string;
} {
    const body = object(value, 'Factory', previous ? ['name', 'parentId'] : ['id', 'name', 'parentId']);
    if (previous && !Object.keys(body).length)
        throw new ValidationError('Factory update must contain a field');
    return {
        ...(body.id === undefined ? {} : { id: identifier(body.id, 'id') }),
        name: body.name === undefined && previous ? previous.name : text(body.name, 'name', 120),
        parentId: body.parentId === undefined ? previous?.parentId ?? null : body.parentId === null ? null : identifier(body.parentId, 'parentId'),
    };
}
export function webUrl(value: unknown, name: string, originOnly = false): string {
    let url: URL;
    try {
        url = new URL(text(value, name, 2000));
    }
    catch {
        throw new ValidationError(`${name}: valid HTTP(S) URL required`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (originOnly && (url.pathname !== '/' || url.search || url.hash))) {
        throw new ValidationError(`${name}: HTTP(S), no credentials${originOnly ? ', origin only' : ''}`);
    }
    return originOnly ? url.origin : url.href;
}
export function lineInput(value: unknown, previous?: ProductionLine): Omit<ProductionLine, 'id'> & {
    id?: string;
} {
    const fields = ['name', 'factoryId', 'orchestratorUrl', 'webviewUrl', 'tokenEnv'];
    const body = object(value, 'Production line', previous ? fields : ['id', ...fields]);
    if (previous && !Object.keys(body).length)
        throw new ValidationError('Line update must contain a field');
    const get = (key: keyof ProductionLine) => body[key] === undefined && previous ? previous[key] : body[key];
    const tokenEnv = text(get('tokenEnv'), 'tokenEnv', 128);
    if (!LINE_TOKEN_PATTERN.test(tokenEnv))
        throw new ValidationError('tokenEnv: use a configured WERK_LINE_<NAME>_TOKEN reference');
    return {
        ...(body.id === undefined ? {} : { id: identifier(body.id, 'id') }),
        name: text(get('name'), 'name', 120), factoryId: identifier(get('factoryId'), 'factoryId'),
        orchestratorUrl: webUrl(get('orchestratorUrl'), 'orchestratorUrl', true),
        webviewUrl: webUrl(get('webviewUrl'), 'webviewUrl'), tokenEnv,
    };
}
/** Validate remote counters before using them in portfolio arithmetic. */
export function validateOverview(value: unknown): OrchestratorOverview {
    const body = object(value, 'Orchestrator overview');
    if (body.schemaVersion !== 1 || !['mock', 'cli', 'mixed'].includes(body.mode as string) || typeof body.observedAt !== 'string' || !Number.isFinite(Date.parse(body.observedAt))) {
        throw new ValidationError('Unsupported orchestrator overview');
    }
    identifier(body.project, 'overview.project');
    const groups = { tasks: ['total', 'queued', 'running', 'simulated', 'blocked'], workers: ['total', 'online', 'offline', 'slotsTotal', 'slotsBusy', 'slotsAvailable'], snapshots: ['total', 'before', 'after'] };
    for (const [group, keys] of Object.entries(groups)) {
        const counters = object(body[group], group, group === 'tasks' ? [...keys, 'review'] : keys);
        if (group === 'tasks' && counters.review !== undefined && (!Number.isSafeInteger(counters.review) || Number(counters.review) < 0)) throw new ValidationError('Invalid tasks.review');
        for (const key of keys)
            if (!Number.isSafeInteger(counters[key]) || Number(counters[key]) < 0)
                throw new ValidationError(`Invalid ${group}.${key}`);
    }
    const result = body as unknown as OrchestratorOverview;
    if (result.tasks.total !== result.tasks.queued + result.tasks.running + result.tasks.simulated + result.tasks.blocked + (result.tasks.review ?? 0)
        || result.workers.total !== result.workers.online + result.workers.offline
        || result.snapshots.total !== result.snapshots.before + result.snapshots.after
        || result.workers.slotsBusy + result.workers.slotsAvailable > result.workers.slotsTotal) {
        throw new ValidationError('Inconsistent orchestrator counters');
    }
    // Mock execution never provides monetary consumption: remote arbitrary cost fields cannot become reported cost.
    return { schemaVersion: 1, observedAt: result.observedAt, mode: result.mode, project: result.project,
        capabilities: body.capabilities === undefined || body.capabilities === null ? null : validateLineCapabilities(body.capabilities, result.project),
        tasks: result.tasks, workers: result.workers, snapshots: result.snapshots, cost: { amountUsd: null, reason: result.mode === 'mock' ? 'unavailable_mock' : 'unavailable_provider' } };
}
