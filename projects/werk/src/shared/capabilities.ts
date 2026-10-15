import { identifier, object } from './contracts.js';
import { ValidationError } from './errors.js';
import type { WorkerCounts } from './factory.js';

export interface CapabilityProfile { id: string; provider: 'claude' | 'codex'; mode?: 'mock' | 'cli'; }
export interface RepositoryCapacity { repositoryId: string | null; implicitOnly?: boolean; provider: 'claude' | 'codex'; mode: 'mock' | 'cli'; slotsAvailable: number; }
export interface RegisteredCapabilities { repositoryCapacity?: RepositoryCapacity[]; repositoryCapacityTruncated?: boolean; eligibleCapacity?: { provider: 'claude' | 'codex'; mode: 'mock' | 'cli'; slotsAvailable: number }[]; providers: ('claude' | 'codex')[]; profiles: CapabilityProfile[]; profilesTruncated: boolean; }
export interface LineCapabilities extends RegisteredCapabilities {
    schemaVersion: 1;
    project: string;
    execution: 'mock' | 'cli' | 'mixed';
    context: 'unbound' | 'pinned';
    intake: ('structured_task' | 'requirement_ref' | 'pinned_iteration')[];
    capacity: { kind: 'observed'; observedAt: string; workers: WorkerCounts };
}
/** Remote capability announcements are bounded allowlisted data, never arbitrary configuration. */
export function validateLineCapabilities(value: unknown, expectedProject?: string): LineCapabilities {
    const body = object(value, 'Line capabilities', ['schemaVersion', 'project', 'execution', 'context', 'intake', 'providers', 'profiles', 'profilesTruncated', 'capacity', 'eligibleCapacity', 'repositoryCapacity', 'repositoryCapacityTruncated']);
    const project = identifier(body.project, 'capabilities.project');
    if (body.schemaVersion !== 1 || !['mock', 'cli', 'mixed'].includes(body.execution as string) || !['unbound', 'pinned'].includes(body.context as string) || (expectedProject !== undefined && project !== expectedProject)) throw new ValidationError('Unsupported or mismatched line capabilities');
    const context = body.context as LineCapabilities['context'];
    const intake = context === 'pinned' ? ['requirement_ref', 'pinned_iteration'] as const : ['structured_task', 'requirement_ref'] as const;
    if (!Array.isArray(body.intake) || body.intake.length !== intake.length || new Set(body.intake).size !== body.intake.length || body.intake.some(item => !intake.includes(item))) throw new ValidationError('Invalid line intake capabilities');
    if (!Array.isArray(body.providers) || body.providers.length > 2 || new Set(body.providers).size !== body.providers.length || body.providers.some(provider => !['claude', 'codex'].includes(provider))) throw new ValidationError('Invalid line provider capabilities');
    if (!Array.isArray(body.profiles) || body.profiles.length > 64 || typeof body.profilesTruncated !== 'boolean') throw new ValidationError('Invalid or oversized line profile capabilities');
    const providers = body.providers as ('claude' | 'codex')[];
    const profiles = body.profiles.map(value => {
        const profile = object(value, 'Capability profile', ['id', 'provider', 'mode']);
        if (!['claude', 'codex'].includes(profile.provider as string) || !providers.includes(profile.provider as 'claude' | 'codex')) throw new ValidationError('Invalid capability profile provider');
        if (profile.mode !== undefined && (!['mock', 'cli'].includes(profile.mode as string) || (profile.mode === 'cli' && profile.provider !== 'codex'))) throw new ValidationError('Invalid capability mode');
        return { ...(profile.mode === undefined ? {} : { mode: profile.mode as 'mock' | 'cli' }), id: identifier(profile.id, 'capability profile ID'), provider: profile.provider as 'claude' | 'codex' };
    });
    if (new Set(profiles.map(profile => `${profile.id}:${profile.provider}:${profile.mode ?? 'mock'}`)).size !== profiles.length) throw new ValidationError('Duplicate capability profiles');
    if ((body.profilesTruncated && profiles.length !== 64) || (!body.profilesTruncated && providers.some(provider => !profiles.some(profile => profile.provider === provider)))) throw new ValidationError('Inconsistent profile capability coverage');
    const capacity = object(body.capacity, 'Observed capacity', ['kind', 'observedAt', 'workers']);
    if (capacity.kind !== 'observed' || typeof capacity.observedAt !== 'string' || capacity.observedAt.length > 40 || !Number.isFinite(Date.parse(capacity.observedAt))) throw new ValidationError('Invalid capacity observation');
    const keys = ['total', 'online', 'offline', 'slotsTotal', 'slotsBusy', 'slotsAvailable'] as const;
    const workers = object(capacity.workers, 'Observed workers', keys);
    for (const key of keys) if (!Number.isSafeInteger(workers[key]) || Number(workers[key]) < 0) throw new ValidationError('Invalid observed worker counts');
    const counts = Object.fromEntries(keys.map(key => [key, workers[key]])) as unknown as WorkerCounts;
    if (counts.total !== counts.online + counts.offline || counts.slotsBusy + counts.slotsAvailable > counts.slotsTotal) throw new ValidationError('Inconsistent observed worker capacity');
    let eligibleCapacity: RegisteredCapabilities['eligibleCapacity'];
    if (body.eligibleCapacity !== undefined) {
        if (!Array.isArray(body.eligibleCapacity) || body.eligibleCapacity.length > 4) throw new ValidationError('Invalid eligible capacity');
        eligibleCapacity = body.eligibleCapacity.map(value => {
            const row = object(value, 'Eligible capacity', ['provider', 'mode', 'slotsAvailable']);
            if (!['codex', 'claude'].includes(row.provider as string) || !['mock', 'cli'].includes(row.mode as string) || !Number.isSafeInteger(row.slotsAvailable) || Number(row.slotsAvailable) < 0) throw new ValidationError('Invalid eligible capacity');
            return { provider: row.provider as 'codex' | 'claude', mode: row.mode as 'mock' | 'cli', slotsAvailable: Number(row.slotsAvailable) };
        });
        if (new Set(eligibleCapacity.map(row => row.provider + ':' + row.mode)).size !== eligibleCapacity.length) throw new ValidationError('Duplicate eligible capacity');
    }
    let repositoryCapacity: RepositoryCapacity[] | undefined;
    if (body.repositoryCapacity !== undefined) {
        if (!Array.isArray(body.repositoryCapacity) || body.repositoryCapacity.length > 260 || typeof body.repositoryCapacityTruncated !== 'boolean') throw new ValidationError('Invalid repository capacity.');
        repositoryCapacity = body.repositoryCapacity.map(value => {
            const row = object(value, 'Repository capacity', ['repositoryId', 'implicitOnly', 'provider', 'mode', 'slotsAvailable']);
            if (!['codex', 'claude'].includes(row.provider as string) || !['mock', 'cli'].includes(row.mode as string) || !Number.isSafeInteger(row.slotsAvailable) || Number(row.slotsAvailable) < 0 || (row.implicitOnly !== undefined && typeof row.implicitOnly !== 'boolean')) throw new ValidationError('Invalid repository capacity.');
            const repositoryId = row.repositoryId === null ? null : identifier(row.repositoryId, 'Repository capacity ID');
            if (row.implicitOnly && (repositoryId === null || row.mode !== 'cli')) throw new ValidationError('Invalid implicit repository capacity.');
            return { repositoryId, ...(row.implicitOnly ? { implicitOnly: true } : {}), provider: row.provider as 'codex' | 'claude', mode: row.mode as 'mock' | 'cli', slotsAvailable: Number(row.slotsAvailable) };
        });
        if (new Set(repositoryCapacity.map(row => JSON.stringify([row.repositoryId, !!row.implicitOnly, row.provider, row.mode]))).size !== repositoryCapacity.length || (body.repositoryCapacityTruncated && repositoryCapacity.length !== 260)) throw new ValidationError('Inconsistent repository capacity.');
    } else if (body.repositoryCapacityTruncated !== undefined) throw new ValidationError('Repository capacity is required with its truncation flag.');
    return { ...(repositoryCapacity ? { repositoryCapacity, repositoryCapacityTruncated: body.repositoryCapacityTruncated as boolean } : {}), ...(eligibleCapacity ? { eligibleCapacity } : {}), schemaVersion: 1, project, execution: body.execution as LineCapabilities['execution'], context, intake: [...intake], providers: [...providers], profiles, profilesTruncated: body.profilesTruncated,
        capacity: { kind: 'observed', observedAt: capacity.observedAt, workers: counts } };
}
