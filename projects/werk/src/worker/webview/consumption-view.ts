import type { ConsumptionStatus } from '../application/consumption';

/** Shared wording for observed allowance and the editor that owns its policy. */
export function consumptionStateLabel(report: ConsumptionStatus | null): string {
  if (!report) return 'Unavailable';
  if (!report.accountingAvailable) return 'Accounting unavailable';
  if (!report.policy.enabled) return 'Limits off';
  return report.blocked ? 'New model calls blocked' : 'Within allowance';
}

export function consumptionBlockedMessage(report: ConsumptionStatus | null): string {
  switch (report?.reason) {
    case 'accounting_unavailable': return 'Usage accounting is unavailable. New model calls are blocked to avoid losing consumption records. Check the worker storage and restart after resolving the error.';
    case 'unmeasured_usage': return 'A model call did not report complete usage. New model calls are blocked for this period because the remaining allowance cannot be verified. Review the run evidence; the block clears at the next UTC reset.';
    case 'exhausted': return 'This worker has used its share for this period. New model calls stay blocked until the next UTC reset or you increase the saved allowance.';
    case 'insufficient_reservation': return 'The remaining share is smaller than the reservation for another model call. Wait for the next UTC reset or review the allowance and reservation in Settings.';
    default: return '';
  }
}

/** The graphic compares a configured allowance, never an inferred account balance. */
export function consumptionAllocation(report: ConsumptionStatus | null) {
  const known = report?.accountingAvailable === true;
  const enabled = report?.policy.enabled === true;
  const measured = known ? report.measuredTokens : null;
  const reserved = known ? report.reservedTokens : null;
  const remaining = known && enabled && !report.uncertainInvocations ? report.remainingTokens : null;
  const aboveAllowance = known && enabled ? Math.max(0, report.chargedTokens - report.workerAllowance) : null;
  const scale = report ? Math.max(report.workerAllowance, report.chargedTokens) : 0;
  const segments = remaining !== null && measured !== null && reserved !== null && scale > 0
    ? { measured: measured / scale * 100, reserved: reserved / scale * 100, remaining: remaining / scale * 100 }
    : null;
  return { measured, reserved, remaining, aboveAllowance, segments };
}
