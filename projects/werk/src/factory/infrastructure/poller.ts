import { DomainError } from '../../shared/errors.js';
import { validateOverview } from '../../shared/factory.js';
import type { LineOverview, ProductionLine } from '../../shared/factory.js';
import type { LineReader } from '../application/ports.js';
/** Read-only HTTP adapter with a process-wide request limit and per-line in-flight deduplication. */
export class HttpLineReader implements LineReader {
    private readonly credentials: Readonly<Record<string, string>>;
    private readonly timeoutMs: number;
    private readonly concurrency: number;
    private active = 0;
    private readonly queue: (() => void)[] = [];
    private readonly inflight = new Map<string, Promise<Omit<LineOverview, 'line'>>>();
    private readonly controllers = new Set<AbortController>();
    private stopped = false;
    constructor(credentials: Readonly<Record<string, string>>, timeoutMs = 3000, concurrency = 4) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
            throw new DomainError('invalid_input', 'Polling timeout 50–30000 ms and concurrency 1–16 required');
        this.credentials = { ...credentials };
        this.timeoutMs = timeoutMs;
        this.concurrency = concurrency;
    }
    close() {
        this.stopped = true;
        for (const controller of this.controllers) controller.abort();
    }
    private async slot(signal: AbortSignal): Promise<boolean> {
        if (signal.aborted || this.stopped) return false;
        if (this.active < this.concurrency) {
            this.active++;
            return true;
        }
        return new Promise<boolean>(resolve => {
            const acquire = () => {
                signal.removeEventListener('abort', cancel);
                resolve(true);
            };
            const cancel = () => {
                const index = this.queue.indexOf(acquire);
                if (index >= 0) this.queue.splice(index, 1);
                resolve(false);
            };
            this.queue.push(acquire);
            signal.addEventListener('abort', cancel, { once: true });
        });
    }
    private release() {
        const next = this.queue.shift();
        // The queued request inherits this occupied slot; a newcomer cannot steal it.
        if (next) next();
        else this.active--;
    }
    async read(line: ProductionLine): Promise<LineOverview> {
        const key = line.orchestratorUrl + '\n' + line.tokenEnv;
        let result = this.inflight.get(key);
        if (!result) {
            // Bound retained work across concurrent portfolio requests as well as network connections.
            if (this.stopped || this.inflight.size >= this.concurrency + 256)
                return { line, status: 'unavailable', checkedAt: new Date().toISOString(), overview: null,
                    error: this.stopped ? 'Factory service is stopping' : 'Factory polling capacity is busy; retry later' };
            result = this.inspect(line);
            this.inflight.set(key, result);
            void result.then(() => this.inflight.delete(key), () => this.inflight.delete(key));
        }
        return { line, ...await result };
    }
    private async inspect(line: ProductionLine): Promise<Omit<LineOverview, 'line'>> {
        const unavailable = (status: LineOverview['status'], error: string): Omit<LineOverview, 'line'> => ({ status, error, overview: null, checkedAt: new Date().toISOString() });
        const credential = this.credentials[line.tokenEnv];
        if (!credential)
            return unavailable('unconfigured', 'The referenced line credential is not configured on this Factory service');
        const controller = new AbortController();
        this.controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs).unref();
        let acquired = false;
        try {
            acquired = await this.slot(controller.signal);
            if (!acquired || controller.signal.aborted)
                return unavailable('unavailable', 'Orchestrator summary timed out or was cancelled while waiting to poll');
            if (this.stopped)
                return unavailable('unavailable', 'Factory service is stopping');
            const response = await fetch(new URL('/v1/overview', line.orchestratorUrl), { headers: { Authorization: 'Bearer ' + credential }, redirect: 'error', signal: controller.signal });
            if (response.status === 401 || response.status === 403) {
                await response.body?.cancel();
                return unavailable('unauthorized', 'The orchestrator rejected the configured line credential');
            }
            if (!response.ok) {
                await response.body?.cancel();
                return unavailable('unavailable', 'Orchestrator summary request failed (HTTP ' + response.status + ')');
            }
            const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
            let size = 0;
            if (reader)
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        size += value.byteLength;
                        if (size > 65536) {
                            await reader.cancel();
                            return unavailable('invalid', 'Orchestrator summary exceeds 64 KiB');
                        }
                        chunks.push(value);
                    }
                }
                finally {
                    reader.releaseLock();
                }
            try {
                const overview = validateOverview(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                return { status: 'available', error: null, overview, checkedAt: new Date().toISOString() };
            }
            catch {
                return unavailable('invalid', 'The endpoint returned an unsupported or invalid overview');
            }
        }
        catch {
            return unavailable('unavailable', controller.signal.aborted ? 'Orchestrator summary timed out or was cancelled' : 'Unable to reach the orchestrator summary endpoint');
        }
        finally {
            clearTimeout(timeout);
            this.controllers.delete(controller);
            if (acquired) this.release();
        }
    }
}
