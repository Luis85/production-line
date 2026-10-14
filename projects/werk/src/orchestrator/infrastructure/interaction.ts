import { object, text, identifier } from '../../shared/contracts.js';
import { webUrl } from '../../shared/factory.js';
import { DomainError } from '../../shared/errors.js';
import { privateJson } from '../../shared/http/bounded-client.js';
/** The selected worker owns provider access, transcripts and execution. Tokens are request-scoped. */
export async function interactWithWorker(input: unknown, assertWorker: (id: string) => void) {
  const body = object(input, 'Worker interaction', ['workerUrl', 'workerToken', 'action', 'message', 'sessionId']);
  const origin = webUrl(body.workerUrl, 'workerUrl', true), credential = text(body.workerToken, 'workerToken', 1024);
  if (!['read', 'send', 'cancel', 'new'].includes(body.action as string)) throw new DomainError('invalid_input', 'action: read|send|cancel|new');
  const status = await privateJson(new URL('/status', origin), credential);
  assertWorker(identifier(status.workerId, 'registered workerId'));
  if (body.action === 'read') {
    const { sessions, chat } = await privateJson(new URL('/api/chat/session', origin), credential);
    return { workerId: status.workerId, sessions, chat };
  }
  const sessionId = identifier(body.sessionId, 'sessionId');
  if (body.action === 'new') {
    const current = await privateJson(new URL('/api/chat/session', origin), credential);
    if (current.sessions.selected !== sessionId) throw new DomainError('conflict', 'The selected worker session changed. Reconnect before creating a task.');
    const selected = current.sessions.records.find((record: { id: string }) => record.id === sessionId);
    if (!selected) throw new DomainError('unavailable', 'The selected worker session is unavailable. Reconnect and retry.');
    const created = await privateJson(new URL('/api/sessions', origin), credential, 'POST', { action: 'create', title: 'New task', provider: identifier(selected.provider, 'session provider') });
    const result = await privateJson(new URL('/api/chat/session', origin), credential);
    if (result.sessions.selected !== created.selected) throw new DomainError('conflict', 'A task session was created, but the selected session changed. Refresh before continuing.');
    return { workerId: status.workerId, sessions: result.sessions, chat: result.chat };
  }
  const chat = await privateJson(new URL(body.action === 'send' ? '/api/chat' : '/api/chat/cancel', origin), credential, 'POST', body.action === 'send' ? { sessionId, message: text(body.message, 'message', 8000) } : { sessionId });
  return { workerId: status.workerId, chat };
}
