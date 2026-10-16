import {
  validateWorkerInteractionRequest, validateWorkerInteractionStatus, validateWorkerInteractionSessionView,
  validateWorkerInteractionSessions, validateWorkerInteractionChat,
} from '../../shared/worker-interaction.js';
import { privateJson } from '../../shared/http/bounded-client.js';
import { workerInteraction, type WorkerInteractionPort } from '../application/worker-interaction.js';

/** Request-scoped access; credentials are neither persisted nor returned by the application port. */
export async function interactWithWorker(input: unknown, assertWorker: (id: string) => void, signal?: AbortSignal) {
  const command = validateWorkerInteractionRequest(input);
  const request = (path: string, body?: unknown) => privateJson(new URL(path, command.workerUrl), command.workerToken, body === undefined ? 'GET' : 'POST', body, { signal });
  const worker: WorkerInteractionPort = {
    status: async () => validateWorkerInteractionStatus(await request('/status')),
    session: async () => validateWorkerInteractionSessionView(await request('/api/chat/session')),
    createSession: async provider => validateWorkerInteractionSessions(await request('/api/sessions', { action: 'create', title: 'New task', provider })),
    send: async (sessionId, message) => validateWorkerInteractionChat(await request('/api/chat', { sessionId, message })),
    cancel: async sessionId => validateWorkerInteractionChat(await request('/api/chat/cancel', { sessionId })),
  };
  return workerInteraction(command, worker, assertWorker, signal);
}
