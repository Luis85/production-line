import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { identifier } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { parseRequirementRef } from '../../shared/wiki.js';
import { CONTEXT_MANIFEST_MAX_BYTES, type ContextManifest } from '../../shared/context.js';

export const CONTEXT_LIMITS = Object.freeze({ files: 32, depth: 8, fileBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024, manifestBytes: CONTEXT_MANIFEST_MAX_BYTES });
export interface ContextFile { path: string; objectId: string; mode: string }
export interface ContextSource {
    repository: string;
    commit: string;
    files: readonly ContextFile[];
    read(file: ContextFile): Promise<Uint8Array>;
}
export interface ContextRequest { project: string; vaultRoot: string; wikilink: string }
export function assertContextActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DomainError('unavailable', 'Context resolution cancelled');
}
const invalid = (message: string): never => { throw new DomainError('invalid_input', message); };
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export function vaultRoot(value: string): string {
    if (value === '.') return '';
    if (!value || value.startsWith('/') || /[:\\\p{Cc}]/u.test(value)
        || value.split('/').some(part => !part || part === '.' || part === '..')) {
        return invalid('--vault-root must be . or a literal repository-relative directory without traversal');
    }
    return value;
}
function metadata(content: string, path: string): Record<string, unknown> {
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) return {};
    const parsed = parseDocument(match[1], { uniqueKeys: true });
    if (parsed.errors.length) return invalid(`Invalid frontmatter: ${path}`);
    let value: unknown;
    try { value = parsed.toJS({ maxAliasCount: 50 }); }
    catch { return invalid(`Invalid frontmatter aliases: ${path}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(`Frontmatter must be an object: ${path}`);
    return value as Record<string, unknown>;
}
function string(value: unknown, name: string, max = 2000): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid(`${name} must be nonempty text, at most ${max} characters`);
    return value.trim();
}
function dependencies(meta: Record<string, unknown>, path: string): string[] {
    const refs = meta.factory_context === undefined ? [] : meta.factory_context;
    if (!Array.isArray(refs) || refs.length > CONTEXT_LIMITS.files || refs.some(ref => typeof ref !== 'string')) {
        return invalid(`factory_context must contain at most ${CONTEXT_LIMITS.files} explicit Wikilinks: ${path}`);
    }
    return refs as string[];
}

/** Read-only, explicit context collection. Repository text never supplies tools or execution policy. */
export async function resolveContext(source: ContextSource, request: ContextRequest, signal?: AbortSignal): Promise<ContextManifest> {
    assertContextActive(signal);
    const project = identifier(request.project, 'project'), root = vaultRoot(request.vaultRoot);
    const prefix = root ? root + '/' : '';
    const vaultFiles = source.files.filter(file => file.path.startsWith(prefix));
    if (root && !vaultFiles.length) return invalid(`Vault root is absent from the pinned commit: ${root}`);
    const resolve = (wikilink: string): ContextFile => {
        const reference = parseRequirementRef(wikilink);
        if (reference.anchor !== null) return invalid(`Unsupported context reference (headings and blocks): ${wikilink}`);
        if (/\.[^/]+$/.test(reference.path)) return invalid(`Unsupported context reference (only whole Markdown notes): ${wikilink}`);
        const target = prefix + reference.path + '.md';
        const exact = vaultFiles.filter(file => file.path === target);
        const matches = exact.length ? exact : reference.path.includes('/') ? [] : vaultFiles.filter(file => file.path.split('/').at(-1) === reference.path + '.md');
        if (!matches.length) return invalid(`Missing context note in pinned vault: ${wikilink}`);
        if (matches.length !== 1) return invalid(`Ambiguous context note: ${wikilink}; use its vault-relative path`);
        const file = matches[0];
        if (file.path.length > 2000 || /[\\:\p{Cc}]/u.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..')) {
            return invalid(`Unsupported context path: ${file.path}`);
        }
        if (!['100644', '100755'].includes(file.mode)) return invalid(`Context note is not a regular committed file: ${file.path}`);
        return file;
    };
    const requirement = parseRequirementRef(request.wikilink).wikilink;
    const first = resolve(requirement);
    const queue = [{ file: first, depth: 0 }], discovered = new Set([first.path]);
    const files: Array<{ path: string; objectId: string; sha256: string; bytes: number; content: string; dependencies: string[] }> = [];
    let total = 0;
    let ready: { featureId: string; title: string; acceptance: string[] } | undefined;
    for (let index = 0; index < queue.length; index++) {
        assertContextActive(signal);
        const { file, depth } = queue[index];
        const bytes = await source.read(file);
        assertContextActive(signal);
        if (bytes.byteLength > CONTEXT_LIMITS.fileBytes || (total += bytes.byteLength) > CONTEXT_LIMITS.totalBytes) {
            throw new DomainError('too_large', 'Context exceeds file or total byte limit');
        }
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return invalid(`Context note must be UTF-8: ${file.path}`); }
        const meta = metadata(content, file.path);
        if (index === 0) {
            if (meta.factory_status !== 'ready_for_implementation') return invalid('Requirement must declare factory_status: ready_for_implementation');
            const acceptance = meta.factory_acceptance;
            if (!Array.isArray(acceptance) || !acceptance.length || acceptance.length > 100) return invalid('factory_acceptance must contain 1–100 nonempty criteria');
            ready = { featureId: identifier(meta.factory_id, 'factory_id'), title: string(meta.title, 'title', 200),
                acceptance: acceptance.map(value => string(value, 'factory_acceptance')) };
        }
        const refs = dependencies(meta, file.path);
        const resolved = refs.map(resolve);
        files.push({ path: file.path, objectId: file.objectId, sha256: digest(bytes), bytes: bytes.byteLength, content,
            dependencies: [...new Set(resolved.map(item => item.path))].sort() });
        for (const dependency of resolved) {
            if (discovered.has(dependency.path)) continue;
            if (depth + 1 > CONTEXT_LIMITS.depth) throw new DomainError('too_large', 'Context exceeds dependency depth limit');
            if (discovered.size >= CONTEXT_LIMITS.files) throw new DomainError('too_large', 'Context exceeds file count limit');
            discovered.add(dependency.path);
            queue.push({ file: dependency, depth: depth + 1 });
        }
    }
    const manifest: Omit<ContextManifest, 'sha256'> = { schemaVersion: 1, resolverVersion: 'werk-context/1', project, repository: source.repository,
        commit: source.commit, vaultRoot: root || '.', requirement: { wikilink: requirement, path: first.path, ...ready! },
        policy: { dependencies: 'factory_context_only', contentTrust: 'untrusted_source', limits: CONTEXT_LIMITS },
        files: files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) };
    assertContextActive(signal);
    const result = { ...manifest, sha256: digest(JSON.stringify(manifest)) };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > CONTEXT_LIMITS.manifestBytes) {
        throw new DomainError('too_large', 'Serialized context manifest exceeds byte limit');
    }
    return result;
}
