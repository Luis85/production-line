import { unknownUsage, type ProviderUsage } from '../application/run-evidence.js';

const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const cost = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Input includes cached input. Cache fields describe subsets, never additional input to sum. */
export function providerUsage(protocol: 'codex' | 'openai' | 'anthropic' | 'claude', value: unknown): ProviderUsage {
  const response = record(value), raw = record(response.usage);
  let inputTokens = count(raw.input_tokens);
  let cacheReadTokens = count(protocol === 'codex' ? raw.cached_input_tokens : protocol === 'openai' ? record(raw.input_tokens_details).cached_tokens : raw.cache_read_input_tokens);
  let cacheWriteTokens = protocol === 'anthropic' || protocol === 'claude' ? count(raw.cache_creation_input_tokens) : null;
  if ((protocol === 'anthropic' || protocol === 'claude') && inputTokens !== null) {
    // These protocols report uncached input separately. A full total requires every component.
    inputTokens = cacheReadTokens === null || cacheWriteTokens === null ? null : count(inputTokens + cacheReadTokens + cacheWriteTokens);
  }
  if (inputTokens !== null) {
    if (cacheReadTokens !== null && cacheReadTokens > inputTokens) cacheReadTokens = null;
    if (cacheWriteTokens !== null && cacheWriteTokens > inputTokens) cacheWriteTokens = null;
  }
  const usage: ProviderUsage = { inputTokens, outputTokens: count(raw.output_tokens), cacheReadTokens, cacheWriteTokens,
    providerReportedCostUsd: protocol === 'claude' ? cost(response.total_cost_usd) : null, source: 'provider_reported', reason: null };
  return [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.providerReportedCostUsd].some(value => value !== null) ? usage : unknownUsage();
}
/** Codex emits per-turn usage. Publish a cumulative total for this one invocation. */
export function codexUsage(output: Buffer, onUsage?: (usage: ProviderUsage) => void) {
  if (!onUsage) return;
  let total: ProviderUsage | undefined;
  for (const line of output.toString('utf8').split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'turn.completed') continue;
    const usage = providerUsage('codex', event);
    if (!total) total = usage;
    else for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      total[key] = total[key] === null || usage[key] === null ? null : count(total[key]! + usage[key]!);
    }
    if (![total.inputTokens, total.outputTokens, total.cacheReadTokens, total.cacheWriteTokens].some(value => value !== null)) total = unknownUsage('Usage was missing or invalid for at least one completed provider turn.');
    onUsage({ ...total });
  }
}
