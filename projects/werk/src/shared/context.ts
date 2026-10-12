/** Immutable server-authored context identity; repository contents are fetched separately. */
export interface PinnedContextReference {
    sha256: string;
    commit: string;
    featureId: string;
    path: string;
}
export const CONTEXT_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export interface ContextManifest {
    schemaVersion: 1;
    resolverVersion: string;
    project: string;
    repository: string;
    commit: string;
    vaultRoot: string;
    requirement: { wikilink: string; path: string; featureId: string; title: string; acceptance: string[] };
    policy: {
        dependencies: 'factory_context_only';
        contentTrust: 'untrusted_source';
        limits: { files: number; depth: number; fileBytes: number; totalBytes: number; manifestBytes: number };
    };
    files: Array<{ path: string; objectId: string; sha256: string; bytes: number; content: string; dependencies: string[] }>;
    /** SHA-256 of UTF-8 JSON.stringify of preceding fields in emitted order, excluding this field. */
    sha256: string;
}
