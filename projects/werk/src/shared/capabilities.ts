import { identifier, object } from './contracts.js';
import { ValidationError } from './errors.js';
import type { WorkerCounts } from './factory.js';

export interface CapabilityProfile { id: string; provider: 'claude' | 'codex'; mode?: 'mock' | 'cli'; }
export interface RegisteredCapabilities { providers: ('claude' | 'codex')[]; profiles: CapabilityProfile[]; profilesTruncated: boolean; }
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
    const body = object(value, 'Line capabilities', ['schemaVersion', 'project', 'execution', 'context', 'intake', 'providers', 'profiles', 'profilesTruncated', 'capacity']);
    const project = identifier(body.project, 'capabilities.project');
    if (body.schemaVersion !== 1 || !['mock', 'cli', 'mixed'].includes(String(body.execution)) || !['unbound', 'pinned'].includes(String(body.context)) || (expectedProject !== undefined && project !== expectedProject)) throw new ValidationError('Unsupported or mismatched line capabilities');
    const context = body.context as LineCapabilities['context'];
    const intake = context === 'pinned' ? ['requirement_ref', 'pinned_iteration'] as const : ['structured_task', 'requirement_ref'] as const;
    if (!Array.isArray(body.intake) || body.intake.length !== intake.length || new Set(body.intake).size !== body.intake.length || body.intake.some(item => !intake.includes(item))) throw new ValidationError('Invalid line intake capabilities');
    if (!Array.isArray(body.providers) || body.providers.length > 2 || new Set(body.providers).size !== body.providers.length || body.providers.some(provider => !['claude', 'codex'].includes(provider))) throw new ValidationError('Invalid line provider capabilities');
    if (!Array.isArray(body.profiles) || body.profiles.length > 64 || typeof body.profilesTruncated !== 'boolean') throw new ValidationError('Invalid or oversized line profile capabilities');
    const providers = body.providers as ('claude' | 'codex')[];
    const profiles = body.profiles.map(value => {
        const profile = object(value, 'Capability profile', ['id', 'provider', 'mode']);
        if (!['claude', 'codex'].includes(String(profile.provider)) || !providers.includes(profile.provider as 'claude' | 'codex')) throw new ValidationError('Invalid capability profile provider');
        if (profile.mode !== undefined && (!['mock', 'cli'].includes(String(profile.mode)) || (profile.mode === 'cli' && profile.provider !== 'codex'))) throw new ValidationError('Invalid capability mode');
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
    return { schemaVersion: 1, project, execution: body.execution as LineCapabilities['execution'], context, intake: [...intake], providers: [...providers], profiles, profilesTruncated: body.profilesTruncated,
        capacity: { kind: 'observed', observedAt: capacity.observedAt, workers: counts } };
}
