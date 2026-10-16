import { DomainError } from '../../shared/errors.js';
import { unknownUsage, type ProviderUsage } from './run-evidence.js';

export interface ConsumptionPolicy {
  enabled: boolean;
  period: 'daily' | 'monthly';
  allowance: number;
  workerPercent: number;
  perRunReservation: number;
}
export const defaultConsumptionPolicy = (): ConsumptionPolicy => ({ enabled: false, period: 'daily', allowance: 1000000, workerPercent: 50, perRunReservation: 10000 });
export function workerAllowance(policy: ConsumptionPolicy): number {
  // Divide first to avoid overflowing the safe integer range during multiplication.
  return Math.floor(policy.allowance / 100) * policy.workerPercent + Math.floor((policy.allowance % 100) * policy.workerPercent / 100);
}
export function validateConsumptionPolicy(input: unknown): ConsumptionPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['enabled', 'period', 'allowance', 'workerPercent', 'perRunReservation'].includes(key))) throw new DomainError('invalid_input', 'Use the documented consumption policy fields.');
  const value = input as ConsumptionPolicy;
  if (typeof value.enabled !== 'boolean' || !['daily', 'monthly'].includes(value.period) || !Number.isSafeInteger(value.allowance) || value.allowance < 1 || !Number.isSafeInteger(value.workerPercent) || value.workerPercent < 1 || value.workerPercent > 100 || !Number.isSafeInteger(value.perRunReservation) || value.perRunReservation < 1 || value.perRunReservation > workerAllowance(value)) throw new DomainError('invalid_input', 'Set a positive whole-token allowance, a worker share from 1 to 100 percent, and a per-run reservation no larger than the worker allowance.');
  return { enabled: value.enabled, period: value.period, allowance: value.allowance, workerPercent: value.workerPercent, perRunReservation: value.perRunReservation };
}
export interface ConsumptionWindow { periodStart: string; periodEnd: string; }
/** All consumption belongs to the UTC calendar window in which the invocation started. */
export function consumptionWindow(period: ConsumptionPolicy['period'], at: Date): ConsumptionWindow {
  const start = new Date(at);
  start.setUTCHours(0, 0, 0, 0);
  if (period === 'monthly') start.setUTCDate(1);
  const end = new Date(start);
  if (period === 'monthly') end.setUTCMonth(end.getUTCMonth() + 1); else end.setUTCDate(end.getUTCDate() + 1);
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}
export interface ConsumptionAttempt { id: string; provider: string; startedAt: string; reservedTokens: number; }
export interface ConsumptionRecord extends ConsumptionAttempt {
  state: 'active' | 'complete' | 'uncertain' | 'released';
  usage: ProviderUsage;
}
export interface ConsumptionSummary {
  trackingStartedAt: string;
  measuredTokens: number;
  reservedTokens: number;
  chargedTokens: number;
  activeInvocations: number;
  uncertainInvocations: number;
}
export type ConsumptionBlockReason = 'disabled' | 'available' | 'unmeasured_usage' | 'exhausted' | 'insufficient_reservation' | 'accounting_unavailable';
export interface ConsumptionStatus extends ConsumptionWindow, Omit<ConsumptionSummary, 'trackingStartedAt'> {
  schemaVersion: 1;
  policy: ConsumptionPolicy;
  trackingStartedAt: string | null;
  workerAllowance: number;
  remainingTokens: number;
  blocked: boolean;
  reason: ConsumptionBlockReason;
  accountingAvailable: boolean;
}
/** Storage owns atomicity and identity generation; application policy owns all admission decisions. */
export interface ConsumptionLedger {
  init(): Promise<void>;
  close(): void;
  summary(window: ConsumptionWindow): ConsumptionSummary;
  transaction<T>(operation: () => T): T;
  create(provider: string, startedAt: string, reservedTokens: number): ConsumptionRecord;
  get(id: string): ConsumptionRecord;
  save(record: ConsumptionRecord): void;
}
export interface ConsumptionRuntime {
  status(): ConsumptionStatus;
  begin(provider: string): ConsumptionAttempt;
  observe(id: string, usage: ProviderUsage): boolean;
  finish(id: string, usage?: ProviderUsage, complete?: boolean): void;
  /** Only release an invocation when no provider was dispatched. */
  release(id: string): void;
}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1e12 ? value : null;
export function measuredConsumption(usage: ProviderUsage): number { return (count(usage.inputTokens) ?? 0) + (count(usage.outputTokens) ?? 0); }
export function completeConsumption(usage: ProviderUsage): boolean { return count(usage.inputTokens) !== null && count(usage.outputTokens) !== null; }
/** Provider observations are cumulative, not deltas. Never let a later smaller or absent counter erase evidence. */
export function observeConsumption(previous: ProviderUsage, incoming: ProviderUsage): ProviderUsage {
  const next = unknownUsage();
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const a = count(previous[key]), b = count(incoming[key]);
    next[key] = a === null ? b : b === null ? a : Math.max(a, b);
  }
  const cost = incoming.providerReportedCostUsd;
  next.providerReportedCostUsd = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= 1e9 ? Math.max(previous.providerReportedCostUsd ?? 0, cost) : previous.providerReportedCostUsd;
  next.costBasis = next.providerReportedCostUsd === null ? 'unavailable' : incoming.costBasis ?? previous.costBasis ?? 'unknown';
  next.source = [next.inputTokens, next.outputTokens, next.cacheReadTokens, next.cacheWriteTokens, next.providerReportedCostUsd].some(value => value !== null) ? 'provider_reported' : 'unavailable';
  next.reason = next.source === 'unavailable' ? 'The provider did not report complete token usage.' : null;
  return next;
}
export function consumptionStatus(policy: ConsumptionPolicy, window: ConsumptionWindow, summary: ConsumptionSummary): ConsumptionStatus {
  const limit = workerAllowance(policy), remainingTokens = Math.max(0, limit - summary.chargedTokens);
  const reason: ConsumptionBlockReason = !policy.enabled ? 'disabled' : summary.uncertainInvocations ? 'unmeasured_usage' : remainingTokens <= 0 ? 'exhausted' : remainingTokens < policy.perRunReservation ? 'insufficient_reservation' : 'available';
  return { schemaVersion: 1, policy: { ...policy }, ...window, ...summary, workerAllowance: limit, remainingTokens, blocked: !['available', 'disabled'].includes(reason), reason, accountingAvailable: true };
}
const blockedMessages: Partial<Record<ConsumptionBlockReason, string>> = {
  unmeasured_usage: 'Consumption limit paused this worker because a provider invocation has incomplete usage. Wait for the next UTC window or explicitly change the consumption policy.',
  exhausted: 'The worker has used its configured token allowance. Wait for the next UTC window or change the consumption policy.',
  insufficient_reservation: 'The remaining worker allowance is smaller than the per-run reservation. Wait for the next UTC window or change the consumption policy.',
  accounting_unavailable: 'Consumption accounting is unavailable. Restart the worker after repairing its private accounting storage.',
};
class ConsumptionAdmissionError extends DomainError {
  constructor(message: string) { super('conflict', message); }
}
export class WorkerConsumption implements ConsumptionRuntime {
  private ledger: ConsumptionLedger;
  private policy: () => ConsumptionPolicy;
  private now: () => Date;
  private failed = false;
  private lastSummary: ConsumptionSummary | undefined;
  constructor(ledger: ConsumptionLedger, policy: () => ConsumptionPolicy, now: () => Date = () => new Date()) { this.ledger = ledger; this.policy = policy; this.now = now; }
  async init(): Promise<void> { try { await this.ledger.init(); } catch (error) { this.failed = true; throw error; } }
  close(): void { this.ledger.close(); }
  private accounting<T>(operation: () => T): T {
    if (this.failed) throw new DomainError('unavailable', blockedMessages.accounting_unavailable!);
    try { return operation(); } catch (error) {
      // Semantic admission failures leave storage healthy. Every other failure is latched until restart.
      if (!(error instanceof ConsumptionAdmissionError)) this.failed = true;
      throw error;
    }
  }
  status(): ConsumptionStatus {
    const policy = this.policy(), window = consumptionWindow(policy.period, this.now());
    if (!this.failed) {
      try { this.lastSummary = this.ledger.summary(window); return consumptionStatus(policy, window, this.lastSummary); }
      catch { this.failed = true; }
    }
    const summary = this.lastSummary ?? { trackingStartedAt: '', measuredTokens: 0, reservedTokens: 0, chargedTokens: 0, activeInvocations: 0, uncertainInvocations: 0 };
    return { ...consumptionStatus(policy, window, summary), trackingStartedAt: summary.trackingStartedAt || null, accountingAvailable: false, blocked: true, reason: 'accounting_unavailable' };
  }
  begin(provider: string): ConsumptionAttempt {
    if (typeof provider !== 'string' || !provider.trim() || provider.length > 100 || /[\x00-\x1f]/.test(provider)) throw new DomainError('invalid_input', 'Choose a valid consumption provider.');
    return this.accounting(() => this.ledger.transaction(() => {
      const policy = this.policy(), at = this.now(), window = consumptionWindow(policy.period, at);
      const status = consumptionStatus(policy, window, this.ledger.summary(window));
      if (status.blocked) throw new ConsumptionAdmissionError(blockedMessages[status.reason]!);
      const record = this.ledger.create(provider, at.toISOString(), policy.enabled ? policy.perRunReservation : 0);
      return { id: record.id, provider: record.provider, startedAt: record.startedAt, reservedTokens: record.reservedTokens };
    }));
  }
  observe(id: string, usage: ProviderUsage): boolean {
    return this.accounting(() => this.ledger.transaction(() => {
      const record = this.ledger.get(id);
      if (record.state !== 'active') return false;
      record.usage = observeConsumption(record.usage, usage); this.ledger.save(record);
      const policy = this.policy(), window = consumptionWindow(policy.period, new Date(record.startedAt));
      return policy.enabled && this.ledger.summary(window).measuredTokens >= workerAllowance(policy);
    }));
  }
  finish(id: string, usage = unknownUsage(), complete = true): void {
    this.accounting(() => this.ledger.transaction(() => {
      const record = this.ledger.get(id);
      if (record.state !== 'active') return;
      record.usage = observeConsumption(record.usage, usage);
      record.state = complete && completeConsumption(usage) ? 'complete' : 'uncertain';
      this.ledger.save(record);
    }));
  }
  release(id: string): void {
    this.accounting(() => this.ledger.transaction(() => {
      const record = this.ledger.get(id);
      if (record.state !== 'active') return;
      if (measuredConsumption(record.usage) || record.usage.source === 'provider_reported') throw new ConsumptionAdmissionError('An invocation with observed usage cannot release its consumption reservation.');
      record.state = 'released'; this.ledger.save(record);
    }));
  }
}
