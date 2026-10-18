import type { ModelResult } from './model-contract.js';
import type { ProviderUsage } from './run-evidence.js';
import type { ToolRuntime } from './tool-runtime.js';

/** The concrete factory retains the parent's provider, profile, FR scope and private credentials. */
export interface DelegationChildInput { id: string; prompt: string; tools: ToolRuntime; signal: AbortSignal; }
export interface DelegationChildResult { sessionId: string; result: ModelResult; usage: ProviderUsage; }
/** Persisted against the same FR before dispatch and before returning child output to the parent. */
export interface DelegationReceipt {
  id: string;
  sessionId?: string;
  state: 'started' | 'completed' | 'needs_input' | 'failed' | 'cancelled';
  tools: string[];
  startedAt: string;
  finishedAt?: string;
  result?: ModelResult;
  usage?: ProviderUsage;
  error?: string;
}
export interface DelegationPorts {
  runChild(input: DelegationChildInput): Promise<DelegationChildResult>;
  record(receipt: DelegationReceipt): Promise<void>;
}
