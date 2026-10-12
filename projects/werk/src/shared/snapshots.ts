import { ValidationError } from './errors.js';
import { object, identifier, text, sha256, gitCommit } from './validation.js';
export interface Snapshot {
    schemaVersion: 1;
    id: string;
    pairId: string;
    phase: 'before' | 'after';
    capturedAt: string;
    workerId: string;
    project: string;
    taskId: string;
    attempt: number;
    profileId: string;
    provider: string;
    mode: 'mock' | 'cli';
    review?: { baseCommit: string; patchSha256: string; patchBytes: number; artifactPath: string };
    configuration: Record<string, unknown>;
    runtime: {
        processInstanceId: string;
        node: string;
        platform: string;
        arch: string;
        workerVersion: string;
        adapterVersion: string;
    };
    execution: {
        outcome: 'pending' | 'simulated' | 'change-set' | 'failed' | 'interrupted';
        durationMs: number | null;
        timingSource: 'monotonic' | 'unavailable_after_restart';
        error: string | null;
    };
    resources: {
        scope: 'worker_process';
        rssBytes: number;
        heapUsedBytes: number;
        peakRssBytes: number;
        cpuUserMicros: number;
        cpuSystemMicros: number;
        cpuDeltaMicros: number | null;
        uptimeSeconds: number;
        hostLoad1m: number;
    };
    health: {
        serverLastContactAt: string | null;
        heartbeatErrors: number;
        eventLoopDelayP95Ms: number | null;
        recoveredAfterCrash: boolean;
    };
    usage: {
        inputTokens: number | null;
        outputTokens: number | null;
        cacheReadTokens: number | null;
        cacheWriteTokens: number | null;
        providerReportedCostUsd: number | null;
        estimatedCostUsd: number | null;
        subscriptionAllocatedCostUsd: number | null;
        subscriptionRemaining: number | null;
        source: 'unavailable_mock' | 'unavailable_provider';
        reason: string;
    };
    quality: {
        build: 'not_run';
        tests: 'not_run';
        testsTotal: number | null;
        testsPassed: number | null;
        coveragePercent: number | null;
        lintErrors: number | null;
        securityFindings: number | null;
        gate: 'not_evaluated';
    };
    provenance: {
        repoBaseCommit: string | null;
        testedCommit: string | null;
        contextManifestHash: string | null;
        skillsVersion: string | null;
        iterationId: string | null;
        featureId: string | null;
        sourceCommit: string | null;
        policyVersion: string;
        configurationHash: string;
        systemPromptHash: string;
        artifactPath: string;
    };
}
/** Every measurement has an explicit unit and scope; unavailable mock evidence stays null. */
export function validateSnapshot(value: unknown): Snapshot {
    const root = object(value, 'Snapshot', ['schemaVersion', 'id', 'pairId', 'phase', 'capturedAt', 'workerId', 'project', 'taskId', 'attempt', 'profileId', 'provider', 'mode', 'configuration', 'runtime', 'execution', 'resources', 'health', 'usage', 'quality', 'provenance', 'review']);
    const invalid = (message: string): never => { throw new ValidationError(message); };
    const finite = (value: unknown, name: string, integer = false): number => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
            invalid(`${name}: finite nonnegative ${integer ? 'safe integer' : 'number'} required`);
        return value as number;
    };
    const timestamp = (value: unknown, name: string) => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
            invalid(`${name}: UTC ISO timestamp required`);
    };
    if (root.schemaVersion !== 1 || !['before', 'after'].includes(root.phase as string) || !['mock', 'cli'].includes(String(root.mode)) || !['claude', 'codex'].includes(root.provider as string))
        invalid('Invalid snapshot envelope');
    for (const name of ['pairId', 'workerId', 'project', 'taskId', 'profileId'])
        if (identifier(root[name], name) !== root[name])
            invalid(`${name}: identifier must not contain surrounding whitespace`);
    if (root.id !== root.pairId + '-' + root.phase)
        invalid('Invalid snapshot identity');
    if (finite(root.attempt, 'attempt', true) < 1)
        invalid('attempt must be positive');
    timestamp(root.capturedAt, 'capturedAt');
    const runtime = object(root.runtime, 'runtime', ['processInstanceId', 'node', 'platform', 'arch', 'workerVersion', 'adapterVersion']);
    for (const key of ['processInstanceId', 'node', 'platform', 'arch', 'workerVersion', 'adapterVersion'])
        text(runtime[key], `runtime.${key}`, 100);
    identifier(runtime.processInstanceId, 'processInstanceId');
    const execution = object(root.execution, 'execution', ['outcome', 'durationMs', 'timingSource', 'error']);
    if (!['monotonic', 'unavailable_after_restart'].includes(execution.timingSource as string))
        invalid('Invalid timing source');
    if (execution.durationMs !== null)
        finite(execution.durationMs, 'durationMs');
    if (execution.error !== null)
        text(execution.error, 'execution.error', 300);
    if (root.phase === 'before' && (execution.outcome !== 'pending' || execution.durationMs !== null || execution.error !== null))
        invalid('Before snapshot must be pending without duration/error');
    if (root.phase === 'after' && !['simulated', 'change-set', 'failed', 'interrupted'].includes(execution.outcome as string))
        invalid('After snapshot requires terminal outcome');
    if ((execution.outcome === 'simulated' && root.mode !== 'mock') || (execution.outcome === 'change-set' && root.mode !== 'cli')) invalid('Execution outcome does not match mode');
    if (root.mode === 'cli' && root.provider !== 'codex') invalid('Live provider must be Codex');
    if (execution.outcome === 'change-set') {
        const review = object(root.review, 'Review', ['baseCommit', 'patchSha256', 'patchBytes', 'artifactPath']);
        gitCommit(review.baseCommit, 'review.baseCommit'); sha256(review.patchSha256, 'review.patchSha256');
        if (finite(review.patchBytes, 'review.patchBytes', true) < 1 || Number(review.patchBytes) > 1048576 || review.artifactPath !== `review/${root.pairId}/change.patch`) invalid('Invalid review artifact');
    } else if (root.review !== undefined) invalid('Review evidence requires a live change-set');
    if (execution.timingSource === 'unavailable_after_restart' && execution.durationMs !== null)
        invalid('Restarted timing must be unavailable');
    const resources = object(root.resources, 'resources', ['scope', 'rssBytes', 'heapUsedBytes', 'peakRssBytes', 'cpuUserMicros', 'cpuSystemMicros', 'cpuDeltaMicros', 'uptimeSeconds', 'hostLoad1m']);
    if (resources.scope !== 'worker_process')
        invalid('Resources must declare worker_process scope');
    for (const key of ['rssBytes', 'heapUsedBytes', 'peakRssBytes', 'cpuUserMicros', 'cpuSystemMicros'])
        finite(resources[key], key, true);
    if (resources.cpuDeltaMicros !== null)
        finite(resources.cpuDeltaMicros, 'cpuDeltaMicros', true);
    for (const key of ['uptimeSeconds', 'hostLoad1m'])
        finite(resources[key], key);
    if (root.phase === 'before' && resources.cpuDeltaMicros !== null)
        invalid('Before snapshot cannot contain CPU delta');
    const health = object(root.health, 'health', ['serverLastContactAt', 'heartbeatErrors', 'eventLoopDelayP95Ms', 'recoveredAfterCrash']);
    if (health.serverLastContactAt !== null)
        timestamp(health.serverLastContactAt, 'serverLastContactAt');
    finite(health.heartbeatErrors, 'heartbeatErrors', true);
    if (health.eventLoopDelayP95Ms !== null)
        finite(health.eventLoopDelayP95Ms, 'eventLoopDelayP95Ms');
    if (typeof health.recoveredAfterCrash !== 'boolean')
        invalid('recoveredAfterCrash must be boolean');
    if (health.recoveredAfterCrash && (root.phase !== 'after' || execution.outcome !== 'interrupted' || execution.timingSource !== 'unavailable_after_restart' || resources.cpuDeltaMicros !== null))
        invalid('Inconsistent recovered snapshot');
    const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'providerReportedCostUsd', 'estimatedCostUsd', 'subscriptionAllocatedCostUsd', 'subscriptionRemaining'];
    const usage = object(root.usage, 'usage', [...usageKeys, 'source', 'reason']);
    if (usage.source !== (root.mode === 'mock' ? 'unavailable_mock' : 'unavailable_provider'))
        invalid('Mock usage must declare unavailable_mock');
    text(usage.reason, 'usage.reason', 1000);
    for (const key of usageKeys)
        if (usage[key] !== null)
            invalid(`Mock ${key} must be null, not measured or estimated`);
    const qualityKeys = ['testsTotal', 'testsPassed', 'coveragePercent', 'lintErrors', 'securityFindings'];
    const quality = object(root.quality, 'quality', [...qualityKeys, 'build', 'tests', 'gate']);
    if (quality.build !== 'not_run' || quality.tests !== 'not_run' || quality.gate !== 'not_evaluated')
        invalid('Mock quality must remain unevaluated');
    for (const key of qualityKeys)
        if (quality[key] !== null)
            invalid(`Mock ${key} must be null`);
    const provenance = object(root.provenance, 'provenance', ['repoBaseCommit', 'testedCommit', 'contextManifestHash', 'skillsVersion', 'iterationId', 'featureId', 'sourceCommit', 'policyVersion', 'configurationHash', 'systemPromptHash', 'artifactPath']);
    for (const key of ['repoBaseCommit', 'testedCommit', 'sourceCommit'])
        if (provenance[key] !== null)
            gitCommit(provenance[key], key);
    if (provenance.contextManifestHash !== null)
        sha256(provenance.contextManifestHash, 'contextManifestHash');
    for (const key of ['iterationId', 'featureId'])
        if (provenance[key] !== null)
            identifier(provenance[key], key);
    if (provenance.skillsVersion !== null)
        text(provenance.skillsVersion, 'skillsVersion', 100);
    text(provenance.policyVersion, 'policyVersion', 100);
    // Schema v1 historically accepted labels; preserve their provenance without inventing digests.
    text(provenance.configurationHash, 'configurationHash', 100);
    text(provenance.systemPromptHash, 'systemPromptHash', 100);
    const canonicalPath = `.factory/runs/${root.taskId}/attempt-${root.attempt}/${root.pairId}/${root.phase}.json`;
    if (provenance.artifactPath !== canonicalPath)
        invalid('Snapshot artifact path mismatch');
    const configuration = object(root.configuration, 'configuration');
    // Limit configuration depth and reject non-JSON/non-finite values even for direct callers.
    const seen = new Set<object>();
    let count = 0;
    const visit = (v: unknown, depth: number): void => {
        if (++count > 1000 || depth > 8)
            invalid('Snapshot configuration is too complex');
        if (v === null || typeof v === 'boolean' || typeof v === 'string')
            return;
        if (typeof v === 'number') {
            if (!Number.isFinite(v))
                invalid('Configuration numbers must be finite');
            return;
        }
        if (typeof v !== 'object' || !v || seen.has(v))
            invalid('Configuration must contain acyclic JSON values');
        seen.add(v as object);
        if (!Array.isArray(v))
            object(v, 'configuration object');
        for (const child of Object.values(v as object))
            visit(child, depth + 1);
        seen.delete(v as object);
    };
    visit(configuration, 0);
    if (new TextEncoder().encode(JSON.stringify(configuration)).byteLength > 16384)
        invalid('Snapshot configuration limit: 16 KiB');
    return root as unknown as Snapshot;
}
