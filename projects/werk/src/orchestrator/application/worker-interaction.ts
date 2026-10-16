import { DomainError } from '../../shared/errors.js';
import type {
  WorkerInteractionCommand, WorkerInteractionResponse, WorkerInteractionChat,
  WorkerInteractionSessions, WorkerInteractionSessionView,
} from '../../shared/worker-interaction.js';

/** The worker owns execution and transcripts; this port exposes no credentials or HTTP paths. */
export interface WorkerInteractionPort {
  status(): Promise<{ workerId: string }>;
  session(): Promise<WorkerInteractionSessionView>;
  createSession(provider: string): Promise<WorkerInteractionSessions>;
  send(sessionId: string, message: string): Promise<WorkerInteractionChat>;
  cancel(sessionId: string): Promise<WorkerInteractionChat>;
}
export async function workerInteraction(
  command: WorkerInteractionCommand,
  worker: WorkerInteractionPort,
  assertWorker: (id: string) => void,
  signal?: AbortSignal,
): Promise<WorkerInteractionResponse> {
  const assertActive = () => {
    if (signal?.aborted) throw new DomainError('unavailable', 'The worker interaction was cancelled. Reconnect and retry.');
  };
  assertActive();
  const { workerId } = await worker.status();
  assertActive();
  assertWorker(workerId);
  if (command.action === 'read') {
    const { sessions, chat } = await worker.session();
    assertActive();
    return { workerId, sessions, chat };
  }
  const { sessionId } = command;
  if (command.action === 'new') {
    const current = await worker.session();
    assertActive();
    if (current.sessions.selected !== sessionId) throw new DomainError('conflict', 'The selected worker session changed. Reconnect before creating a task.');
    const selected = current.sessions.records.find(record => record.id === sessionId);
    if (!selected?.provider) throw new DomainError('unavailable', 'The selected worker session is unavailable. Reconnect and retry.');
    const created = await worker.createSession(selected.provider);
    assertActive();
    const result = await worker.session();
    assertActive();
    if (result.sessions.selected !== created.selected) throw new DomainError('conflict', 'A task session was created, but the selected session changed. Refresh before continuing.');
    return { workerId, sessions: result.sessions, chat: result.chat };
  }
  const chat = command.action === 'send' ? await worker.send(sessionId, command.message) : await worker.cancel(sessionId);
  assertActive();
  return { workerId, chat };
}
