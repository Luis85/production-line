import { defaultServicePolicy, validateServicePolicy, type ServicePolicy } from '../application/service-access-policy';
import { serviceLimits } from '../application/service-policy';

interface ServicePresetDraft {
  id: string; name: string; executable: string; arguments: string; enabled: boolean;
  lifetimeMinutes: number | string; startupSeconds: number | string; readyText: string;
  restartAttempts: number | string; backoffSeconds: number | string;
}
interface ServicePolicyDraft { enabled: boolean; maxActive: number | string; presets: ServicePresetDraft[]; }
export function servicePolicyDraft(policy: ServicePolicy = defaultServicePolicy()): ServicePolicyDraft {
  return { enabled: policy.enabled, maxActive: policy.maxActive, presets: policy.presets.map(preset => ({
    id: preset.id, name: preset.name, executable: preset.executable, arguments: JSON.stringify(preset.args), enabled: preset.enabled,
    lifetimeMinutes: preset.ttlMs / 60000, startupSeconds: preset.startupTimeoutMs / 1000, readyText: preset.readyText ?? '',
    restartAttempts: preset.restart.maxAttempts, backoffSeconds: preset.restart.backoffMs / 1000,
  })) };
}
const number = (value: number | string) => typeof value === 'string' && !value.trim() ? NaN : Number(value);
function milliseconds(value: number | string, multiplier: number) {
  const raw = number(value) * multiplier, rounded = Math.round(raw);
  return Number.isSafeInteger(rounded) && Math.abs(raw - rounded) < .000001 ? rounded : NaN;
}
function servicePreset(draft: ServicePresetDraft) {
  const label = draft.name.trim() || draft.id || 'Service';
  if (!draft.name.trim()) throw Error('Give each service preset a name.');
  if (!/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(draft.executable.trim())) throw Error(`${label}: enter an absolute executable path.`);
  let args: unknown;
  try { args = JSON.parse(draft.arguments); } catch { throw Error(`${label}: use a JSON array of strings for fixed arguments.`); }
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.length > 2048 || /[\x00-\x1f\x7f]/.test(arg)))
    throw Error(`${label}: use up to 32 fixed arguments, each a string of at most 2,048 characters without control characters.`);
  const ttlMs = milliseconds(draft.lifetimeMinutes, 60000), startupTimeoutMs = milliseconds(draft.startupSeconds, 1000), backoffMs = milliseconds(draft.backoffSeconds, 1000), maxAttempts = number(draft.restartAttempts);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > serviceLimits.maxTtlMs) throw Error(`${label}: maximum lifetime must be from 1 second to 1,440 minutes (24 hours), with millisecond precision.`);
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 60000 || startupTimeoutMs > ttlMs) throw Error(`${label}: startup wait must be 0.1–60 seconds and no longer than its maximum lifetime.`);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > serviceLimits.maxRestarts) throw Error(`${label}: use 0–${serviceLimits.maxRestarts} automatic restart attempts. Zero disables automatic restarts.`);
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 100 || backoffMs > 60000) throw Error(`${label}: restart delay must be 0.1–60 seconds.`);
  return { id: draft.id, name: draft.name.trim(), executable: draft.executable.trim(), args, enabled: draft.enabled,
    ttlMs, startupTimeoutMs, ...(draft.readyText ? { readyText: draft.readyText } : {}), restart: { maxAttempts, backoffMs } };
}
/** The same policy validator protects serialized UI drafts and server updates. */
export function servicePolicyFromDraft(draft: ServicePolicyDraft): ServicePolicy {
  const maxActive = number(draft.maxActive);
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > serviceLimits.maximumActive) throw Error(`Use 1–${serviceLimits.maximumActive} concurrent services for this worker.`);
  if (draft.presets.length > serviceLimits.maximumPresets) throw Error(`Use up to ${serviceLimits.maximumPresets} service presets.`);
  const ids = new Set<string>();
  for (const preset of draft.presets) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(preset.id) || ids.has(preset.id)) throw Error('Give every service a unique ID of 1–64 letters, numbers, underscores or hyphens.');
    ids.add(preset.id);
  }
  return validateServicePolicy({ enabled: draft.enabled, maxActive, presets: draft.presets.map(servicePreset) });
}
export function serviceDraftError(draft: ServicePolicyDraft): string {
  try { servicePolicyFromDraft(draft); return ''; } catch (error) { return (error as Error).message; }
}
export function newServicePreset(presets: readonly ServicePresetDraft[], executable: string): ServicePresetDraft {
  let index = 1; while (presets.some(item => item.id === `service-${index}`)) index++;
  return { id: `service-${index}`, name: '', executable, arguments: '[]', enabled: false,
    lifetimeMinutes: 60, startupSeconds: 30, readyText: '', restartAttempts: 0, backoffSeconds: 1 };
}
