import type { Profile, Task, WorkerPolicy } from '../../shared/contracts.js';
import type { Snapshot } from '../../shared/snapshots.js';
import { ApiError } from '../../shared/http/errors.js';
import { ReportingError } from '../application/errors.js';
import { verifyPinnedContext } from './context.js';
import { request } from '../../shared/http/client.js';
import { responseRecord as record, assignmentResponse as assignment, acknowledgeSnapshot, acknowledgeCompletion, acknowledgeAbandonment, contextIdentity } from './responses.js';
import type { WorkerClient, WorkerGateway, WorkerIdentity } from '../application/ports.js';

/** Injectable transport keeps protocol mapping independently testable. */
export type JsonTransport = (base: string, path: string, token: string, method?: string, body?: unknown) => Promise<unknown>;

/** HTTP details and credential use stop at this adapter boundary. */
export class HttpWorkerGateway implements WorkerGateway {
  private base: string;
  private enrollmentToken: string;
  private transport: JsonTransport;

  constructor(base: string, enrollmentToken: string, transport: JsonTransport = request) {
    this.base = base;
    this.enrollmentToken = enrollmentToken;
    this.transport = transport;
  }

  private async send(path: string, token: string, method: string, body?: unknown): Promise<unknown> {
    try { return await this.transport(this.base, path, token, method, body); }
    catch (error) {
      // A remote response or transport exception may echo credentials or private source.
      // Keep retry semantics, but never carry that diagnostic into worker status or evidence.
      if (error instanceof ApiError)
        throw new ReportingError(`Orchestrator request failed (HTTP ${error.status})`, retryableTransportError(error));
      throw new ReportingError('Orchestrator transport request failed', true);
    }
  }

  async register(profiles: Profile[], policy: WorkerPolicy) {
    const value = record(await this.send('/v1/workers/register', this.enrollmentToken, 'POST', { profiles, policy }));
    if (![value.id, value.token, value.project].every(field => typeof field === 'string' && field.length > 0)) {
      throw Error('Invalid orchestrator registration');
    }
    return { id: value.id as string, token: value.token as string, project: value.project as string };
  }

  connect(identity: WorkerIdentity): WorkerClient {
    const call = (path: string, method = 'POST', body?: unknown) => this.send(path, identity.token, method, body);
    const leaseBody = (task: Task) => ({ lease: task.lease, attempt: task.attempt });
    const taskPath = (task: Task, action: string) => `/v1/worker/tasks/${encodeURIComponent(task.id)}/${action}`;
    return {
      async currentAssignments() {
        const response = record(await call('/v1/worker/assignments/current', 'GET'));
        if (!Array.isArray(response.tasks)) throw Error('Invalid orchestrator assignments response');
        return response.tasks.map(assignment);
      },
      async claim(requestId: string) {
        const response = record(await call('/v1/worker/assignments/next', 'POST', { requestId }));
        return response.task === null ? null : assignment(response.task);
      },
      async heartbeat(task: Task) {
        const updated = assignment(await call(taskPath(task, 'heartbeat'), 'POST', leaseBody(task)));
        if (updated.id !== task.id || updated.lease !== task.lease || updated.attempt !== task.attempt ||
            updated.workerId !== task.workerId || updated.project !== task.project || updated.profile !== task.profile ||
            contextIdentity(updated.context) !== contextIdentity(task.context)) {
          throw Error('Orchestrator renewed a different assignment');
        }
        return updated;
      },
      async verifyContext(task: Task) {
        const query = '?lease=' + encodeURIComponent(task.lease ?? '') + '&attempt=' + encodeURIComponent(task.attempt);
        const manifest = await call(taskPath(task, 'context') + query, 'GET');
        verifyPinnedContext(manifest, task);
      },
      async publishSnapshot(snapshot: Snapshot) { acknowledgeSnapshot(await call('/v1/worker/snapshots', 'POST', snapshot), snapshot); },
      async complete(task: Task) { acknowledgeCompletion(await call(taskPath(task, 'complete'), 'POST', leaseBody(task)), task); },
      async abandon(task: Task) { acknowledgeAbandonment(await call(taskPath(task, 'abandon'), 'POST', leaseBody(task)), task); }
    };
  }
}

/** Compatibility classifier used only at the composition boundary. */
export const retryableTransportError = (error: unknown): boolean =>
  !(error instanceof ApiError) || error.status >= 500 || error.status === 429;
