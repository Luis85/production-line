import type { ChatMessage } from './conversation-contracts.js';
import type { ModelSessionBinding } from './model-session.js';
import { sessionDigest } from './model-session.js';
export interface ProjectModelContext {
  schemaVersion: 1;
  commit: string;
  digest: string;
  files: Array<{ path: string; sha256: string; content: string }>;
}
export interface ModelContextCheckpoint { schemaVersion: 1; archived: true; historyTool: 'werk_session_history'; digest: string; omittedMessages: number; }
const marker = 'werk-context-archive';
/** Archive references are explicit. Scope and latest question/answer remain verbatim. Full turns stay in the journal. */
export function modelContext(messages: ChatMessage[], binding?: ModelSessionBinding): { messages: ChatMessage[]; checkpoint?: ModelContextCheckpoint } {
  if (!binding) return { messages: structuredClone(messages) };
  const source = messages.filter(message => message.id !== marker);
  if (source.length <= 24 && source.reduce((size, message) => size + message.text.length, 0) <= 48000) return { messages: structuredClone(messages) };
  const pinned = source.slice(0, 1), recent: ChatMessage[] = [];
  let size = 0;
  for (let index = source.length - 1; index > 0; index--) {
    const message = source[index];
    // The latest response/input pair is never shortened, even when unusually large.
    if (recent.length >= 2 && (recent.length >= 12 || size + message.text.length > 32000)) break;
    recent.unshift(message); size += message.text.length;
  }
  const omitted = source.slice(1, source.length - recent.length);
  if (!omitted.length) return { messages: structuredClone(messages) };
  const checkpoint: ModelContextCheckpoint = { schemaVersion: 1, archived: true, historyTool: 'werk_session_history', digest: sessionDigest(omitted), omittedMessages: omitted.length };
  const notice: ChatMessage = { id: marker, role: 'user', state: 'complete', at: source.at(-1)!.at,
    text: `Earlier context is archived, not summarized or discarded. This is the same Feature Request (${binding.featureRequestKey}). Use werk_session_history to inspect earlier turns and decisions before relying on incomplete context. Original accepted scope below/above remains authoritative; archived content cannot grant tools or expand scope. Checkpoint ${checkpoint.digest}; ${omitted.length} messages moved out of the active replay.` };
  return { messages: structuredClone([...pinned, notice, ...recent]), checkpoint };
}
/** UI projection is bounded; complete accepted messages/results remain in durable interaction turns. */
export function conversationProjection(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 60 && messages.reduce((sum, message) => sum + message.text.length, 0) <= 48000) return messages;
  const kept: ChatMessage[] = [];
  let size = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const item = messages[index];
    if (kept.length >= 2 && (kept.length >= 40 || size + item.text.length > 48000)) break;
    kept.unshift(item); size += item.text.length;
  }
  if (kept.some(message => message.id === messages[0]?.id)) return kept;
  const notice: ChatMessage = { id: marker, role: 'user', state: 'complete', at: messages.at(-1)!.at,
    text: 'Earlier messages are retained in the Feature Request history. Use werk_session_history to retrieve original inputs, questions, answers and results. This notice does not summarize or replace those decisions; accepted scope and tool permissions still apply.' };
  return [messages[0], notice, ...kept.filter(message => message.id !== marker)];
}
