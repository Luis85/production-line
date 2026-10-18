import { unknownUsage,                    } from '../application/run-evidence.js';

const count = (value         )                => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const cost = (value         )                => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const record = (value         )                          => value && typeof value === 'object' && !Array.isArray(value) ? value                            : {};
/** Input includes cached input. Cache fields describe subsets, never additional input to sum. */
export function providerUsage(protocol                                             , value         )                {
  const response = record(value), raw = record(response.usage);
  // Claude crash results may zero counters after consumption; zero is not evidence of no spend.
  const crashed = protocol === 'claude' && response.subtype === 'error_during_execution';
  const measuredCount = (value         ) => crashed && value === 0 ? null : count(value);
  let inputTokens = measuredCount(raw.input_tokens);
  let cacheReadTokens = measuredCount(protocol === 'codex' ? raw.cached_input_tokens : protocol === 'openai' ? record(raw.input_tokens_details).cached_tokens : raw.cache_read_input_tokens);
  let cacheWriteTokens = protocol === 'anthropic' || protocol === 'claude' ? measuredCount(raw.cache_creation_input_tokens) : null;
  if ((protocol === 'anthropic' || protocol === 'claude') && inputTokens !== null) {
    // These protocols report uncached input separately. A full total requires every component.
    inputTokens = cacheReadTokens === null || cacheWriteTokens === null ? null : count(inputTokens + cacheReadTokens + cacheWriteTokens);
  }
  if (inputTokens !== null) {
    if (cacheReadTokens !== null && cacheReadTokens > inputTokens) cacheReadTokens = null;
    if (cacheWriteTokens !== null && cacheWriteTokens > inputTokens) cacheWriteTokens = null;
  }
  // Claude's total_cost_usd is a client-side estimate, not authoritative billing.
  const providerReportedCostUsd = protocol === 'claude' && !(crashed && response.total_cost_usd === 0) ? cost(response.total_cost_usd) : null;
  const usage                = { inputTokens, outputTokens: measuredCount(raw.output_tokens), cacheReadTokens, cacheWriteTokens,
    providerReportedCostUsd, costBasis: providerReportedCostUsd === null ? 'unavailable' : 'reported_estimate', source: 'provider_reported', reason: null };
  return [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.providerReportedCostUsd].some(value => value !== null) ? usage : unknownUsage(crashed ? 'The provider crash result did not contain reliable usage counters.' : undefined);
}
/** Codex emits per-turn usage. Publish a cumulative total for this one invocation. */
export function codexUsage(output        , onUsage                                 ) {
  if (!onUsage) return;
  let total                           ;
  for (const line of output.toString('utf8').split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'turn.completed') continue;
    const usage = providerUsage('codex', event);
    if (!total) total = usage;
    else for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']         ) {
      total[key] = total[key] === null || usage[key] === null ? null : count(total[key]  + usage[key] );
    }
    if (![total.inputTokens, total.outputTokens, total.cacheReadTokens, total.cacheWriteTokens].some(value => value !== null)) total = unknownUsage('Usage was missing or invalid for at least one completed provider turn.');
    onUsage({ ...total });
  }
}

/** Normalize only the current Claude invocation; retained session totals must not be charged twice. */
export function claudeSessionUsage(response         , resumed         , scope                                      , previous                           )                {
  const usage = providerUsage('claude', response), total = usage.providerReportedCostUsd;
  if (!resumed || scope === 'invocation') return usage;
  const delta = scope === 'session' && total !== null && previous != null && total >= previous ? total - previous : null;
  const reason = 'The resumed provider cost could not be separated from earlier session usage.';
  if (delta === null && [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].every(value => value === null)) return unknownUsage(reason);
  return { ...usage, providerReportedCostUsd: delta, costBasis: delta === null ? 'unavailable' : 'reported_estimate', ...(delta === null ? { reason } : {}) };
}
