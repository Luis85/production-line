import { parseRequirementRef } from './wiki.js';
import { ValidationError } from './errors.js';
import type { TaskInput, Provider, Profile, WorkerPolicy } from './domain.js';
export function workerPolicy(value?: unknown): WorkerPolicy {
    const p = object(value === undefined ? { maxParallel: 1, order: 'priority', maxAttempts: 3, configHash: 'default' } : value, 'Worker policy', ['maxParallel', 'order', 'maxAttempts', 'configHash', 'queueCapacity', 'repositoryIds', 'legacyRepository']);
    if (!Number.isInteger(p.maxParallel) || (p.maxParallel as number) < 1 || (p.maxParallel as number) > 8 || !['priority', 'fifo'].includes(p.order as string) || !Number.isInteger(p.maxAttempts === undefined ? 3 : p.maxAttempts) || (p.maxAttempts as number) < 1 || (p.maxAttempts as number) > 5) {
        throw new ValidationError('Worker policy: maxParallel 1–8, order priority|fifo, maxAttempts 1–5');
    }
    if (p.queueCapacity !== undefined && (!Number.isInteger(p.queueCapacity) || Number(p.queueCapacity) < 0 || Number(p.queueCapacity) > 64)) throw new ValidationError('queueCapacity: 0–64');
    const scope = repositoryScope(p.repositoryIds, p.legacyRepository);
    return { ...scope, ...(p.queueCapacity === undefined ? {} : { queueCapacity: Number(p.queueCapacity) }), maxParallel: p.maxParallel as number, order: p.order as WorkerPolicy['order'], maxAttempts: p.maxAttempts === undefined ? 3 : p.maxAttempts as number, configHash: text(p.configHash, 'configHash', 100) };
}
/** Repository capability is data, never a path or permission to expand a task. */
export function repositoryScope(ids: unknown, legacy: unknown): { repositoryIds?: string[]; legacyRepository?: boolean } {
    if (ids === undefined) {
        if (legacy !== undefined) throw new ValidationError('legacyRepository requires repositoryIds.');
        return {};
    }
    if (!Array.isArray(ids) || ids.length > 64) throw new ValidationError('repositoryIds: at most 64 unique assignment IDs.');
    const repositoryIds = ids.map(value => identifier(value, 'repositoryId'));
    if (new Set(repositoryIds).size !== repositoryIds.length) throw new ValidationError('repositoryIds must be unique.');
    if (legacy !== undefined && typeof legacy !== 'boolean') throw new ValidationError('legacyRepository must be boolean.');
    return { repositoryIds, legacyRepository: legacy === true };
}
export function text(value: unknown, name: string, max = 200): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        throw new ValidationError(`${name}: nonempty string, max ${max}`);
    return value.trim();
}
export function identifier(value: unknown, name: string): string {
    const result = text(value, name, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(result))
        throw new ValidationError(`${name}: letters, digits, _ and - only`);
    return result;
}
/** Require a plain JSON object and reject misspelled or unsupported fields. */
export function object(value: unknown, name: string, allowed?: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new ValidationError(`${name}: expected object`);
    const result = value as Record<string, unknown>;
    if (allowed && Object.keys(result).some(key => !allowed.includes(key)))
        throw new ValidationError(`${name}: unknown field`);
    return result;
}
export function gitCommit(value: unknown, name: string): string {
    const result = text(value, name, 64);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result))
        throw new ValidationError(`${name}: expected SHA-1 or SHA-256 Git commit`);
    return result;
}
export function sha256(value: unknown, name: string): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw new ValidationError(`${name}: expected SHA-256 hex digest`);
    return value;
}
export function taskInput(value: unknown): TaskInput {
    const x = object(value, 'Task', ['project', 'repository', 'title', 'criteria', 'wikilinks', 'provider', 'priority', 'source', 'requirementRef', 'executionMode']);
    const reference = x.requirementRef === undefined ? undefined : parseRequirementRef(x.requirementRef);
    const criteria = x.criteria === undefined && reference ? [] : x.criteria;
    if (!Array.isArray(criteria) || criteria.length < (reference ? 0 : 1) || criteria.length > 30)
        throw new ValidationError(reference ? 'criteria: at most 30 strings' : 'criteria: 1–30 strings');
    const links = x.wikilinks === undefined ? [] : x.wikilinks;
    if (!Array.isArray(links) || links.length > 12)
        throw new ValidationError('wikilinks: at most 12');
    const provider = x.provider === undefined ? 'auto' : x.provider;
    if (typeof provider !== 'string' || !['auto', 'claude', 'codex'].includes(provider))
        throw new ValidationError('Unknown provider');
    if (x.executionMode !== undefined && !['mock', 'cli'].includes(x.executionMode as string)) throw new ValidationError('executionMode: mock or cli');
    if (x.executionMode === 'cli' && provider !== 'codex') throw new ValidationError('Live execution requires provider codex');
    const priority = x.priority === undefined ? 1 : x.priority;
    if (priority !== 1 && priority !== 2)
        throw new ValidationError('priority: 1 or 2');
    let source: TaskInput['source'];
    if (x.source !== undefined) {
        const src = object(x.source, 'Source', ['featureId', 'iterationId', 'branch', 'commit', 'path', 'iterationPrUrl', 'specSha256']);
        source = { featureId: identifier(src.featureId, 'featureId'), iterationId: identifier(src.iterationId, 'iterationId'), branch: text(src.branch, 'branch', 200), commit: gitCommit(src.commit, 'commit'), path: text(src.path, 'path', 500), iterationPrUrl: text(src.iterationPrUrl, 'iterationPrUrl', 500), specSha256: text(src.specSha256, 'specSha256', 64) };
        if (!/^[a-f0-9]{64}$/.test(source.specSha256))
            throw new ValidationError('Invalid source specification hash');
        if (source.path.startsWith('/') || source.path.includes('\\') || source.path.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f]/.test(source.path))
            throw new ValidationError('Source path must be relative to the repository');
        const branch = source.branch;
        if (branch === '@' || branch.startsWith('-') || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') || branch.endsWith('.') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')))
            throw new ValidationError('Invalid source branch');
        let url: URL;
        try {
            url = new URL(source.iterationPrUrl);
        }
        catch {
            throw new ValidationError('Invalid iteration PR URL');
        }
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || /[\x00-\x20\x7f]/.test(source.iterationPrUrl))
            throw new ValidationError('Iteration PR URL must use HTTPS without credentials');
    }
    const normalizedLinks = links.map(value => {
        if (reference) return parseRequirementRef(value).wikilink;
        const link = text(value, 'wikilink', 500);
        if (!/^\[\[[^\[\]\r\n]+\]\]$/.test(link)) throw new ValidationError('Use [[wiki link]] syntax');
        return link;
    });
    const wikilinks = reference ? [...new Set([reference.wikilink, ...normalizedLinks])] : normalizedLinks;
    if (wikilinks.length > 12) throw new ValidationError('wikilinks: at most 12 including requirementRef');
    return {
        project: identifier(x.project, 'project'),
        ...(x.repository !== undefined ? { repository: identifier(x.repository, 'repository') } : {}),
        title: x.title === undefined && reference ? reference.displayTitle : text(x.title, 'title', 200),
        criteria: criteria.map(value => text(value, 'criterion', 2000)),
        wikilinks,
        provider: provider as Provider,
        ...(x.executionMode !== undefined ? { executionMode: x.executionMode as 'mock' | 'cli' } : {}),
        priority,
        ...(reference ? { requirementRef: reference.wikilink } : {}),
        ...(source ? { source } : {})
    };
}
export function profiles(value: unknown): Profile[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 8)
        throw new ValidationError('1–8 profiles required');
    const result = value.map(value => {
        const p = object(value, 'Profile', ['id', 'provider', 'mode', 'maxParallel']);
        if (!['claude', 'codex'].includes(p.provider as string) || !['mock', 'cli'].includes(p.mode as string) || (p.mode === 'cli' && p.provider !== 'codex'))
            throw new ValidationError('Profiles support simulated Claude/Codex or live Codex');
        const limit = p.maxParallel === undefined ? 1 : p.maxParallel;
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 8)
            throw new ValidationError('Profile maxParallel: 1–8');
        return { id: identifier(p.id, 'profile id'), provider: p.provider, mode: p.mode, maxParallel: limit } as Profile;
    });
    if (new Set(result.map(p => p.id)).size !== result.length)
        throw new ValidationError('Profile IDs must be unique');
    return result;
}
