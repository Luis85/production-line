import { DomainError } from '../../shared/errors.js';
import { object } from '../../shared/contracts.js';

/** Named, versioned requirements reference existing machine grants; they never carry executable text. */
export interface DeliveryCheckPack { id: string; version: number; checks: string[]; }
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
export function validateDeliveryCheckPackReferences(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) || new Set(value).size !== value.length)
    invalid('A quality profile can select at most 16 unique named check packs.');
  return [...value] as string[];
}
export function validateDeliveryCheckPacks(value: unknown): DeliveryCheckPack[] {
  if (!Array.isArray(value) || value.length > 32) invalid('Configure at most 32 named check packs.');
  const packs = value.map(item => {
    const raw = object(item, 'Check pack', ['id', 'version', 'checks']);
    if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.id) || !Number.isSafeInteger(raw.version) || Number(raw.version) < 1 || !Array.isArray(raw.checks) || !raw.checks.length || raw.checks.length > 32 || raw.checks.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) || new Set(raw.checks).size !== raw.checks.length)
      invalid('Each check pack requires a unique name, positive version and 1–32 existing command preset IDs.');
    return { id: raw.id, version: Number(raw.version), checks: [...raw.checks] as string[] };
  });
  if (new Set(packs.map(pack => pack.id)).size !== packs.length) invalid('Check pack names must be unique.');
  return packs;
}
export function selectedDeliveryCheckPacks(configuration: { checkPacks?: DeliveryCheckPack[] }, profile: { checkPacks?: string[] }): DeliveryCheckPack[] | undefined {
  if (!profile.checkPacks?.length) return;
  return profile.checkPacks.map(id => {
    const pack = configuration.checkPacks?.find(item => item.id === id);
    if (!pack) invalid('Quality profile references an unknown check pack: ' + id + '.');
    return structuredClone(pack);
  });
}
