import { DomainError } from '../../shared/errors.js';
import type { ServicePreset, ServiceScope } from './process-supervision.js';

export const serviceLimits = Object.freeze({ maximumPresets: 16, maximumActive: 16, defaultActive: 4, maxTtlMs: 86400000, maxRestarts: 5, maxLogBytes: 16384, maxLogEntries: 128, retainedServices: 50 });
const id = (value: unknown, maximum = 100): value is string => typeof value === 'string' && new RegExp('^[a-zA-Z0-9_-]{1,' + maximum + '}$').test(value);
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const integer = (value: unknown, minimum: number, maximum: number) => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
const absolute = (value: unknown) => text(value, 4096) && /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value);
const invalid = () => new DomainError('invalid_input', 'Use a bounded service preset with an absolute executable, fixed arguments, TTL and restart policy.');
/** No shell, argv, environment or working directory comes from a model service call. */
export function validateServicePreset(value: unknown): ServicePreset {
  const p = value as ServicePreset;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(key => !['id', 'name', 'executable', 'args', 'enabled', 'ttlMs', 'startupTimeoutMs', 'readyText', 'restart'].includes(key))
    || !id(p.id, 64) || !text(p.name, 120) || !absolute(p.executable) || typeof p.enabled !== 'boolean'
    || !Array.isArray(p.args) || p.args.length > 32 || p.args.some(arg => typeof arg !== 'string' || arg.length > 2048 || /[\x00-\x1f\x7f]/.test(arg))
    || !integer(p.ttlMs, 1000, serviceLimits.maxTtlMs) || !integer(p.startupTimeoutMs, 100, 60000) || p.startupTimeoutMs > p.ttlMs
    || p.readyText !== undefined && !text(p.readyText, 256) || !p.restart || typeof p.restart !== 'object' || Array.isArray(p.restart)
    || Object.keys(p.restart).some(key => !['maxAttempts', 'backoffMs'].includes(key)) || !integer(p.restart.maxAttempts, 0, serviceLimits.maxRestarts) || !integer(p.restart.backoffMs, 100, 60000)) throw invalid();
  return structuredClone(p);
}
export function validateServiceScope(scope: ServiceScope): void {
  if (!scope || typeof scope !== 'object' || !/^fr-[a-f0-9]{64}$/.test(scope.featureRequestKey) || !id(scope.sessionId)
    || scope.taskId !== undefined && !id(scope.taskId) || scope.runId !== undefined && !id(scope.runId)
    || !absolute(scope.worktree) || !scope.worktreeIdentity || !/^\d+$/.test(scope.worktreeIdentity.dev) || !/^\d+$/.test(scope.worktreeIdentity.ino)
    || !Number.isFinite(scope.worktreeIdentity.birthtimeMs) || scope.worktreeIdentity.birthtimeMs < 0) throw new DomainError('invalid_input', 'Services require a canonical Feature Request and its pinned worktree.');
}
export function serviceFingerprint(value: ServicePreset): string {
  const p = validateServicePreset(value);
  return JSON.stringify([p.id, p.name, p.executable, p.args, p.enabled, p.ttlMs, p.startupTimeoutMs, p.readyText ?? null, p.restart.maxAttempts, p.restart.backoffMs]);
}
export const serviceOperationId = (value: unknown) => id(value);
export const serviceActive = (state: string) => ['starting', 'running', 'restarting', 'stopping'].includes(state);
