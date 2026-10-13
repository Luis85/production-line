import { factoryInput, lineInput } from '../../shared/factory.js';
import { object } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import type { Factory, ProductionLine } from '../../shared/factory.js';

export type MutationOperation = 'factory.create' | 'factory.update' | 'factory.delete' | 'line.create' | 'line.update' | 'line.delete';
export interface FactoryMutation {
    key: string;
    operation: MutationOperation;
    target: string | null;
    payload: unknown;
}
export type MutationResult = Factory | ProductionLine | { deleted: true; id: string };

/** Keys share one registry-wide namespace; do not normalize or silently discard an invalid key. */
export function mutationKey(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
        throw new DomainError('invalid_input', 'Idempotency-Key: 1–128 letters, digits, dot, underscore, colon or hyphen');
    return value;
}

// Normalization uses fixed defaults only to reuse the public field validators. Defaults are never
// included in the patch digest: omitted fields must not depend on the record's current state.
const factoryDefaults: Factory = { id: 'normalization', name: 'Normalization', parentId: null };
const lineDefaults: ProductionLine = { id: 'normalization', name: 'Normalization', factoryId: 'normalization',
    orchestratorUrl: 'https://normalization.invalid', webviewUrl: 'https://normalization.invalid/', tokenEnv: 'WERK_LINE_NORMALIZATION_TOKEN' };
function explicitFields(input: unknown, normalized: object): Record<string, unknown> {
    const body = object(input, 'Update');
    const fields = Object.keys(body).filter(key => body[key] !== undefined);
    if (!fields.length) throw new DomainError('invalid_input', 'Update must contain a field');
    return Object.fromEntries(fields.map(key => [key, (normalized as Record<string, unknown>)[key]]));
}
export function factoryPatch(input: unknown) { return explicitFields(input, factoryInput(input, factoryDefaults)); }
export function linePatch(input: unknown) { return explicitFields(input, lineInput(input, lineDefaults)); }
