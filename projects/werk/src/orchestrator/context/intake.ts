import { gitCommit, identifier } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import type { ContextManifest } from '../../shared/context.js';
import type { TaskContextResolver } from '../application.js';
import { gitContextSource } from './git-source.js';
import { resolveContext, vaultRoot } from './resolver.js';

export interface ContextBinding { repo: string; commit: string; vaultRoot: string }
type Resolve = (binding: Readonly<ContextBinding>, project: string, reference: string, signal: AbortSignal) => Promise<ContextManifest>;
const fromGit: Resolve = async (binding, project, wikilink, signal) => resolveContext(
    await gitContextSource(binding.repo, binding.commit, signal), { project, vaultRoot: binding.vaultRoot, wikilink }, signal,
);

/** Admission, cancellation and binding are owned by the host, never by repository content. */
export class BoundContextIntake implements TaskContextResolver {
    private readonly binding: Readonly<ContextBinding>;
    private readonly project: string;
    private readonly resolvePinned: Resolve;
    private readonly timeoutMs: number;
    private readonly maxConcurrent: number;
    private readonly active = new Map<AbortController, Promise<ContextManifest>>();
    private closed = false;
    constructor(project: string, binding: ContextBinding, options: { resolve?: Resolve; timeoutMs?: number; maxConcurrent?: number } = {}) {
        this.project = identifier(project, 'project');
        if (typeof binding.repo !== 'string' || !binding.repo.trim() || gitCommit(binding.commit, 'context commit') !== binding.commit) {
            throw new DomainError('invalid_input', 'Context binding requires a repository and full lowercase commit ID');
        }
        this.binding = Object.freeze({ repo: binding.repo, commit: binding.commit, vaultRoot: vaultRoot(binding.vaultRoot) || '.' });
        this.resolvePinned = options.resolve ?? fromGit;
        this.timeoutMs = options.timeoutMs ?? 8000;
        this.maxConcurrent = options.maxConcurrent ?? 2;
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000
            || !Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 8) {
            throw new DomainError('invalid_input', 'Invalid context resolver admission limits');
        }
    }
    assertOpen(): void {
        if (this.closed) throw new DomainError('unavailable', 'Context intake is closing');
    }
    resolve(reference: string): Promise<ContextManifest> {
        this.assertOpen();
        if (this.active.size >= this.maxConcurrent) throw new DomainError('unavailable', 'Context resolver is busy; retry with the same idempotency key');
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), this.timeoutMs).unref();
        // Defer execution until its reservation is visible, including synchronously failing adapters.
        const underlying = Promise.resolve().then(async () => {
            try {
                const manifest = await this.resolvePinned(this.binding, this.project, reference, controller.signal);
                if (controller.signal.aborted) throw new DomainError('unavailable', 'Context resolution cancelled or deadline exceeded');
                this.assertOpen();
                return manifest;
            } catch (error) {
                if (controller.signal.aborted) throw new DomainError('unavailable', 'Context resolution cancelled or deadline exceeded');
                throw error;
            } finally { clearTimeout(deadline); this.active.delete(controller); }
        });
        let cancelled!: () => void;
        const cancellation = new Promise<never>((_resolve, reject) => {
            cancelled = () => reject(new DomainError('unavailable', 'Context resolution cancelled or deadline exceeded'));
            controller.signal.addEventListener('abort', cancelled, { once: true });
        });
        const work = Promise.race([underlying, cancellation]).finally(() => controller.signal.removeEventListener('abort', cancelled));
        // Keep admission reserved until underlying I/O settles, even if an uncancellable read outlives the response.
        this.active.set(controller, work);
        return work;
    }
    async close(): Promise<void> {
        this.closed = true;
        for (const controller of this.active.keys()) controller.abort();
        await Promise.allSettled(this.active.values());
    }
}
