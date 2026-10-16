import { DomainError } from './errors.js';
import { webUrl } from './factory.js';
import { identifier, object, text } from './validation.js';

type WorkerAccess = { workerUrl: string; workerToken: string };
export type WorkerInteractionCommand =
  | { action: 'read'; sessionId?: string | null }
  | { action: 'new' | 'cancel'; sessionId: string }
  | { action: 'send'; sessionId: string; message: string };
export type WorkerInteractionRequest = WorkerAccess & WorkerInteractionCommand;
/** Extensions remain available to existing clients; consumers must narrow unknown fields. */
export interface WorkerInteractionMessage {
  [key: string]: unknown;
  id?: string;
  role: 'user' | 'assistant';
  text: string;
  state?: string;
}
export interface WorkerInteractionChat {
  [key: string]: unknown;
  available: boolean;
  busy: boolean;
  phase?: string;
  messages: WorkerInteractionMessage[];
}
export interface WorkerInteractionSession {
  [key: string]: unknown;
  id: string;
  title: string;
  provider?: string;
  busy?: boolean;
  status?: string;
}
export interface WorkerInteractionSessions {
  [key: string]: unknown;
  selected: string;
  records: WorkerInteractionSession[];
}
export interface WorkerInteractionSessionView {
  [key: string]: unknown;
  sessions: WorkerInteractionSessions;
  chat: WorkerInteractionChat;
}
export interface WorkerInteractionResponse {
  [key: string]: unknown;
  workerId: string;
  chat: WorkerInteractionChat;
  sessions?: WorkerInteractionSessions;
}
export function validateWorkerInteractionRequest(value: unknown): WorkerInteractionRequest {
  const body = object(value, 'Worker interaction', ['workerUrl', 'workerToken', 'action', 'message', 'sessionId']);
  const access = { workerUrl: webUrl(body.workerUrl, 'workerUrl', true), workerToken: text(body.workerToken, 'workerToken', 1024) };
  if (body.action === 'read') return { ...access, action: 'read' };
  if (!['new', 'send', 'cancel'].includes(body.action as string)) throw new DomainError('invalid_input', 'action: read|send|cancel|new');
  const sessionId = identifier(body.sessionId, 'sessionId');
  return body.action === 'send'
    ? { ...access, action: 'send', sessionId, message: text(body.message, 'message', 8000) }
    : { ...access, action: body.action as 'new' | 'cancel', sessionId };
}
function invalidResponse(): never {
  throw new DomainError('unavailable', 'The remote component returned an invalid worker interaction response. Reconnect and retry.');
}
function responseObject(value: unknown): Record<string, unknown> {
  try { return object(value, 'Worker interaction response'); } catch { return invalidResponse(); }
}
function responseId(value: unknown): string {
  try { return identifier(value, 'Worker interaction response ID'); } catch { return invalidResponse(); }
}
function optionalString(value: unknown) { if (value !== undefined && typeof value !== 'string') invalidResponse(); }
function optionalBoolean(value: unknown) { if (value !== undefined && typeof value !== 'boolean') invalidResponse(); }
export function validateWorkerInteractionStatus(value: unknown): { workerId: string } {
  const body = responseObject(value);
  return { workerId: responseId(body.workerId) };
}
export function validateWorkerInteractionChat(value: unknown): WorkerInteractionChat {
  const body = responseObject(value);
  if (typeof body.available !== 'boolean' || typeof body.busy !== 'boolean' || !Array.isArray(body.messages)) return invalidResponse();
  optionalString(body.phase);
  for (const value of body.messages) {
    const message = responseObject(value);
    if (!['user', 'assistant'].includes(message.role as string) || typeof message.text !== 'string') return invalidResponse();
    optionalString(message.id); optionalString(message.state);
  }
  return body as unknown as WorkerInteractionChat;
}
export function validateWorkerInteractionSessions(value: unknown): WorkerInteractionSessions {
  const body = responseObject(value), selected = responseId(body.selected);
  if (!Array.isArray(body.records)) return invalidResponse();
  const ids = new Set<string>();
  for (const value of body.records) {
    const session = responseObject(value), id = responseId(session.id);
    if (ids.has(id) || typeof session.title !== 'string') return invalidResponse();
    ids.add(id);
    if (session.provider !== undefined) responseId(session.provider);
    optionalString(session.status); optionalBoolean(session.busy);
  }
  if (!ids.has(selected)) return invalidResponse();
  return body as unknown as WorkerInteractionSessions;
}
export function validateWorkerInteractionSessionView(value: unknown): WorkerInteractionSessionView {
  const body = responseObject(value);
  validateWorkerInteractionSessions(body.sessions); validateWorkerInteractionChat(body.chat);
  return body as unknown as WorkerInteractionSessionView;
}
export function validateWorkerInteractionResponse(value: unknown): WorkerInteractionResponse {
  const body = responseObject(value);
  responseId(body.workerId); validateWorkerInteractionChat(body.chat);
  if (body.sessions !== undefined) validateWorkerInteractionSessions(body.sessions);
  return body as unknown as WorkerInteractionResponse;
}
