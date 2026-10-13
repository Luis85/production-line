import { identifier, object } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';

export interface ManagedRegistry { factories: readonly string[]; lines: readonly string[] }

/** Copy the deployment boundary so callers cannot silently change registry ownership. */
export function managedRegistry(value: unknown): ManagedRegistry | undefined {
    if (value === undefined) return undefined;
    try {
        const input = object(value, 'Managed registry', ['factories', 'lines']);
        const ids = (value: unknown) => {
            if (!Array.isArray(value) || value.length > 1000) throw Error();
            const result = value.map(id => {
                if (identifier(id, 'Managed ID') !== id) throw Error();
                return id as string;
            });
            if (new Set(result).size !== result.length) throw Error();
            return Object.freeze(result);
        };
        return Object.freeze({ factories: ids(input.factories), lines: ids(input.lines) });
    } catch { throw new DomainError('invalid_input', 'Invalid managed registry configuration: factories and lines must contain unique IDs'); }
}

export function managedRegistryEnvironment(value: string | undefined): ManagedRegistry | undefined {
    if (value === undefined) return undefined;
    let parsed: unknown;
    try { if (value.length > 250000) throw Error(); parsed = JSON.parse(value); }
    catch { throw new DomainError('invalid_input', 'Invalid WERK_FACTORY_MANAGED_REGISTRY configuration: expected JSON'); }
    return managedRegistry(parsed);
}

export function assertRegistryEditable(registry: ManagedRegistry | undefined, kind: keyof ManagedRegistry, id: string): void {
    if (registry?.[kind].includes(id)) throw new DomainError('conflict',
        'This resource is managed by the saved system YAML. Use a new state directory for a changed definition, or follow the documented migration procedure.');
}
