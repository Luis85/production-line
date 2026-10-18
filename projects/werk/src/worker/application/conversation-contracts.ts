import type { FeatureRequestReference } from './feature-request-reference.js';
import type { GatePolicy, RequestGatePort } from "./request-gates.js";
import type { ModelProvider } from "./model-contract.js";

import { type ProviderUsage, type RunEvidence, type RunMetadata } from "./run-evidence.js";

import type { InteractionStore } from "./interactions.js";
import type { SerialExecutor } from "./serial-executor.js";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  state: "complete" | "pending" | "error" | "cancelled";
}
export interface Conversation {
  messages: ChatMessage[];
  requestId?: string;
}
export interface ConversationStore {
  read(): Promise<Conversation>;
  write(value: Conversation): Promise<void>;
}
export interface ConversationModel {
  reply(
    messages: ChatMessage[],
    signal: AbortSignal,
    onUsage?: (usage: ProviderUsage) => void,
  ): Promise<string>;
}
export type ConversationEvidence = {
  journal: RunEvidence;
  metadata: () => RunMetadata;
  feature?: () => FeatureRequestReference;
  interactions?: InteractionStore;
  requests?: RequestGatePort;
  requestPolicy?: () => GatePolicy | undefined;
  provider?: () => ModelProvider;
  notifyRequest?: (requestId: string) => void;
  admit?: () => void;
};
export type ChatContext = { chatMessages: ChatMessage[]; assistantId: string };

/** One session owns these mutable lifecycle fields throughout admission and execution. */
export interface ConversationRuntime {
  value: Conversation;
  controller?: AbortController;
  pending?: Promise<void>;
  changing: boolean;
  persistenceError: boolean;
  store: ConversationStore;
  model?: ConversationModel;
  timeoutMs: number | (() => number);
  accepting?: Promise<void>;
  closed: boolean;
  phase: "idle" | "queued" | "running";
  executor?: SerialExecutor;
  sessionId: string;
  evidence?: ConversationEvidence;
}
