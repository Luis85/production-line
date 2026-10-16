import { DomainError } from '../../shared/errors.js';
import { MAX_MAX_RUNTIME_MS } from './execution-policy.js';

/**
 * Operator-configurable tool deadlines. Defaults equal the fixed 0.9.0 limits, so
 * an unchanged policy behaves and serializes exactly as before.
 */
export const toolTimeLimits = Object.freeze({
  /** Per command preset, CLI tool or MCP call. */
  callDefaultMs: 30000, callMinMs: 1000, callMaxMs: 15 * 60 * 1000,
  /** Streamable HTTP MCP responses are also bounded by the HTTP client's five-minute response timeout. */
  httpMcpMaxMs: 5 * 60 * 1000,
  /** Shared by all tool calls of one model invocation, beginning with its first call. */
  windowDefaultMs: 120000, windowMinMs: 10000, windowMaxMs: MAX_MAX_RUNTIME_MS,
  /** Fixed: the model may not raise the number of calls or the web fetch deadline. */
  maxCalls: 32, webFetchMs: 10000,
});
export interface ToolLimits { windowMs: number; }
export const defaultToolLimits = (): ToolLimits => ({ windowMs: toolTimeLimits.windowDefaultMs });

const seconds = (ms: number) => `${Math.round(ms / 1000).toLocaleString('en-US')} s`;
export const formatToolDuration = seconds;
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
function wholeMs(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(`${label} must be whole milliseconds from ${min} to ${max} (${seconds(min)} to ${seconds(max)}).`);
  return Number(value);
}
/** Absent values keep the documented default; documents saved before configurable limits omit them. */
export function callTimeout(value: unknown, label: string, max: number = toolTimeLimits.callMaxMs): number {
  return value === undefined ? toolTimeLimits.callDefaultMs : wholeMs(value, toolTimeLimits.callMinMs, max, `${label} timeout`);
}
export function validateToolLimits(value: unknown): ToolLimits {
  if (value === undefined) return defaultToolLimits();
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'windowMs')) invalid('Use the documented tool limit fields: windowMs.');
  const { windowMs } = value as Record<string, unknown>;
  return { windowMs: windowMs === undefined ? toolTimeLimits.windowDefaultMs : wholeMs(windowMs, toolTimeLimits.windowMinMs, toolTimeLimits.windowMaxMs, 'Tool window') };
}
/** A call deadline longer than the shared window could never be reached, so it is refused rather than silently shortened. */
export function assertWithinWindow(timeoutMs: number, limits: ToolLimits, label: string): void {
  if (timeoutMs > limits.windowMs) invalid(`${label} timeout (${seconds(timeoutMs)}) exceeds the tool window (${seconds(limits.windowMs)}). Raise the tool window or shorten the timeout.`);
}
