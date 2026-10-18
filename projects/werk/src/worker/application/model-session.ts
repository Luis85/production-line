import { createHash } from 'node:crypto';

/** A logical FR session is distinct from provider handles, turns and execution runs. */
export interface ModelSessionBinding {
  schemaVersion: 1;
  logicalSessionId: string;
  featureRequestKey: string;
  providerId: string;
  generation: number;
}
/** Provider-owned checkpoint data stays private and never authorizes tools. */
export interface ModelSessionCheckpoint {
  nativeId?: string;
  providerContextDigest?: string;
  historyDigests?: string[];
  resultDigest?: string;
  cumulativeCostUsd?: number | null;
}
export interface ModelSessionUpdate {
  status: 'idle' | 'running' | 'unknown';
  checkpoint?: ModelSessionCheckpoint;
  lastDispatchDigest?: string;
}
export interface ModelSessionState extends ModelSessionUpdate {
  schemaVersion: 1;
  binding: ModelSessionBinding;
  revision: number;
}
export interface ModelSessionPort {
  load(binding: ModelSessionBinding): Promise<ModelSessionState>;
  save(binding: ModelSessionBinding, expectedRevision: number, next: ModelSessionUpdate): Promise<ModelSessionState>;
}
export interface ModelSessionAccess { binding: ModelSessionBinding; store: ModelSessionPort; }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const sessionDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateModelSessionBinding(value: unknown): asserts value is ModelSessionBinding {
  if (!record(value) || Object.keys(value).some(key => !['schemaVersion', 'logicalSessionId', 'featureRequestKey', 'providerId', 'generation'].includes(key))
    || value.schemaVersion !== 1 || typeof value.logicalSessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.logicalSessionId)
    || typeof value.featureRequestKey !== 'string' || !/^fr-[a-f0-9]{64}$/.test(value.featureRequestKey)
    || !['codex-cli', 'claude-cli', 'openai-api', 'anthropic-api'].includes(String(value.providerId))
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1) throw Error('Invalid model session binding.');
}
export function validateModelSessionUpdate(value: unknown): asserts value is ModelSessionUpdate {
  if (!record(value) || Object.keys(value).some(key => !['status', 'checkpoint', 'lastDispatchDigest'].includes(key))
    || !['idle', 'running', 'unknown'].includes(String(value.status)) || value.lastDispatchDigest !== undefined && !hash(value.lastDispatchDigest)) throw Error('Invalid model session checkpoint.');
  if (value.checkpoint === undefined) return;
  const c = value.checkpoint;
  if (!record(c) || Object.keys(c).some(key => !['nativeId', 'providerContextDigest', 'historyDigests', 'resultDigest', 'cumulativeCostUsd'].includes(key))
    || c.nativeId !== undefined && (typeof c.nativeId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(c.nativeId))
    || c.providerContextDigest !== undefined && !hash(c.providerContextDigest) || c.resultDigest !== undefined && !hash(c.resultDigest)
    || c.historyDigests !== undefined && (!Array.isArray(c.historyDigests) || c.historyDigests.length > 10000 || c.historyDigests.some(item => !hash(item)))
    || c.cumulativeCostUsd !== undefined && c.cumulativeCostUsd !== null && (typeof c.cumulativeCostUsd !== 'number' || !Number.isFinite(c.cumulativeCostUsd) || c.cumulativeCostUsd < 0)) throw Error('Invalid provider session checkpoint.');
}
