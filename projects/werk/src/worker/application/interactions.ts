import type { ModelRequest, ModelResult } from './model-contract.js';
import type { ProviderUsage } from './run-evidence.js';

export type InteractionPhase = 'idle' | 'queued' | 'running' | 'waiting_input' | 'escalated' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface PendingInteraction {
  id: string;
  kind: 'question' | 'escalation';
  message: string;
  choices?: { id: string; label: string }[];
  reason?: string;
  createdAt: string;
  turnId: string;
}
export interface InteractionTurnSummary {
  id: string;
  runId: string | null;
  kind: 'message' | 'answer' | 'resume';
  status: Exclude<InteractionPhase, 'idle'>;
  createdAt: string;
  finishedAt: string | null;
  priorTurnId: string | null;
}
export interface InteractionTurn extends InteractionTurnSummary {
  schemaVersion: 1;
  sessionId: string;
  input: string;
  context: unknown;
  dispatch: ModelRequest | null;
  dispatchDigest: string | null;
  result: ModelResult | null;
  usage: ProviderUsage | null;
  errorCode: string | null;
}
export interface InteractionView {
  schemaVersion: 1;
  sessionId: string;
  revision: number;
  phase: InteractionPhase;
  pending: PendingInteraction | null;
  latestTurn: InteractionTurnSummary | null;
  turns: InteractionTurnSummary[];
  totalTurns: number;
}
export interface InteractionAdmission {
  sessionId: string;
  kind: InteractionTurnSummary['kind'];
  operationId: string;
  expectedRevision?: number;
  pendingId?: string;
  priorTurnId?: string;
  input: string;
  context?: unknown;
}
export interface InteractionCommand {
  action: 'answer' | 'resume';
  sessionId: string;
  expectedRevision: number;
  operationId: string;
  pendingId?: string;
  turnId?: string;
  answer?: string;
  message?: string;
}
export type InteractionEventType = 'accepted' | 'prepared' | 'started' | 'usage_observed' | 'input_requested' | 'escalated' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'pending_cancelled';
interface InteractionEventBase {
  schemaVersion: 1;
  id: string;
  sequence: number;
  sessionId: string;
  revision: number;
  turnId: string | null;
  runId: string | null;
  at: string;
  phase: InteractionPhase;
  usage?: ProviderUsage;
  pendingId?: string;
  requestKind?: 'question' | 'escalation';
  errorCode?: string;
}
export type InteractionEvent = InteractionEventBase & (
  | { type: 'usage_observed'; usage: ProviderUsage }
  | { type: 'input_requested' | 'escalated'; pendingId: string; requestKind: 'question' | 'escalation' }
  | { type: 'failed' | 'interrupted'; errorCode: string }
  | { type: Exclude<InteractionEventType, 'usage_observed' | 'input_requested' | 'escalated' | 'failed' | 'interrupted'> }
);
export interface InteractionEventPage {
  schemaVersion: 1;
  sessionId: string;
  events: InteractionEvent[];
  nextAfter: number;
  hasMore: boolean;
}
export interface InteractionStore {
  events(sessionId: string, after?: number, limit?: number): InteractionEventPage;
  observeUsage(sessionId: string, turnId: string, usage: ProviderUsage): void;
  abandon(sessionId: string, expectedRevision?: number, operationId?: string, pendingId?: string): void;
  deleteSession(sessionId: string): void;
  view(sessionId: string): InteractionView;
  turn(sessionId: string, turnId: string): InteractionTurn;
  operation(sessionId: string, operationId: string): InteractionTurn | undefined;
  accept(input: InteractionAdmission): { turn: InteractionTurn; duplicate: boolean; view: InteractionView };
  prepare(sessionId: string, turnId: string, request: ModelRequest, runId: string): void;
  start(sessionId: string, turnId: string): void;
  complete(sessionId: string, turnId: string, result: ModelResult, usage: ProviderUsage): void;
  fail(sessionId: string, turnId: string, status: 'failed' | 'cancelled' | 'interrupted', code: string): void;
}
