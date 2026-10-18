import { createHash } from 'node:crypto';
import { CONTEXT_MANIFEST_MAX_BYTES } from '../../shared/context.js';
                                                      
import { ReportingError } from '../application/errors.js';

const invalid = ()        => { throw new ReportingError('Pinned requirement context verification failed', false); };
const hash = (value        ) => createHash('sha256').update(value).digest('hex');
const record = (value         )                          => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return value                           ;
};
const exact = (value                         , fields          ) => {
    if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) invalid();
};
const path = (value         )                  => typeof value === 'string' && value.length > 0 && value.length <= 2000 &&
    !value.startsWith('/') && !/[\\:\p{Cc}]/u.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const objectId = (value         )                  => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const sha256 = (value         )                  => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Assignment pointers are server-owned, bounded metadata; they never contain executable source. */
export function validateContextReference(value         )       {
    const reference = record(value);
    exact(reference, ['sha256', 'commit', 'featureId', 'path']);
    if (!sha256(reference.sha256) || !objectId(reference.commit) || !path(reference.path) || !reference.path.endsWith('.md') ||
        typeof reference.featureId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(reference.featureId)) invalid();
}

/** Validate immutable manifest bytes and every file without executing, interpreting or persisting source content. */
export function verifyPinnedContext(value         , task      )       {
    if (!task.context) return invalid();
    validateContextReference(task.context);
    const manifest = record(value);
    exact(manifest, ['schemaVersion', 'resolverVersion', 'project', 'repository', 'commit', 'vaultRoot', 'requirement', 'policy', 'files', 'sha256']);
    if (manifest.schemaVersion !== 1 || manifest.resolverVersion !== 'werk-context/1' || manifest.project !== task.project ||
        manifest.commit !== task.context.commit || manifest.sha256 !== task.context.sha256 ||
        typeof manifest.repository !== 'string' || !manifest.repository || manifest.repository.length > 4096 ||
        !(manifest.vaultRoot === '.' || path(manifest.vaultRoot))) invalid();
    const requirement = record(manifest.requirement);
    exact(requirement, ['wikilink', 'path', 'featureId', 'title', 'acceptance']);
    if (requirement.path !== task.context.path || requirement.featureId !== task.context.featureId || requirement.title !== task.title ||
        typeof requirement.wikilink !== 'string' || !requirement.wikilink || requirement.wikilink.length > 2000 ||
        (task.requirementRef !== undefined && requirement.wikilink !== task.requirementRef) ||
        !Array.isArray(requirement.acceptance) || !requirement.acceptance.length || requirement.acceptance.length > 30 ||
        requirement.acceptance.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000) ||
        JSON.stringify(requirement.acceptance) !== JSON.stringify(task.criteria)) invalid();
    const policy = record(manifest.policy), limits = record(policy.limits);
    exact(policy, ['dependencies', 'contentTrust', 'limits']);
    exact(limits, ['files', 'depth', 'fileBytes', 'totalBytes', 'manifestBytes']);
    if (policy.dependencies !== 'factory_context_only' || policy.contentTrust !== 'untrusted_source' ||
        limits.files !== 32 || limits.depth !== 8 || limits.fileBytes !== 524288 || limits.totalBytes !== 2097152 || limits.manifestBytes !== CONTEXT_MANIFEST_MAX_BYTES ||
        !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 32) invalid();
    const files = new Map                  ();
    let total = 0, previous = '';
    for (const item of manifest.files             ) {
        const file = record(item);
        exact(file, ['path', 'objectId', 'sha256', 'bytes', 'content', 'dependencies']);
        if (!path(file.path) || !file.path.endsWith('.md') || file.path <= previous ||
            (manifest.vaultRoot !== '.' && !file.path.startsWith(manifest.vaultRoot + '/')) ||
            !objectId(file.objectId) || !sha256(file.sha256) || typeof file.content !== 'string' ||
            !Number.isSafeInteger(file.bytes) || (file.bytes          ) < 0 || (file.bytes          ) > 524288 ||
            Buffer.byteLength(file.content, 'utf8') !== file.bytes || hash(file.content) !== file.sha256 ||
            !Array.isArray(file.dependencies) || file.dependencies.length > 32 || file.dependencies.some(dependency => !path(dependency)) ||
            new Set(file.dependencies).size !== file.dependencies.length) invalid();
        total += file.bytes          ;
        if (total > 2097152) invalid();
        previous = file.path          ;
        files.set(file.path          , file.dependencies            );
    }
    const pending = [{ path: task.context.path, depth: 0 }], visited = new Set        ();
    while (pending.length) {
        const next = pending.shift() ;
        if (visited.has(next.path)) continue;
        const dependencies = files.get(next.path);
        if (!dependencies || next.depth > 8) return invalid();
        visited.add(next.path);
        for (const dependency of dependencies) pending.push({ path: dependency, depth: next.depth + 1 });
    }
    if (visited.size !== files.size) invalid();
    if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > CONTEXT_MANIFEST_MAX_BYTES) invalid();
    const { sha256: _digest, ...unsigned } = manifest;
    if (hash(JSON.stringify(unsigned)) !== task.context.sha256) invalid();
}
