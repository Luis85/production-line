import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../shared/errors.js';
import { mutationKey, type FactoryMutation, type MutationResult } from '../application/mutations.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}

/** Called inside the registry's BEGIN IMMEDIATE transaction, including the domain mutation. */
export function withMutationReceipt<T extends MutationResult>(db: DatabaseSync, intent: FactoryMutation, operation: () => T): T {
    mutationKey(intent.key);
    const keyHash = digest(intent.key);
    const requestHash = digest(canonical({ version: 1, operation: intent.operation, target: intent.target, payload: intent.payload }));
    const status = intent.operation.endsWith('.create') ? 201 : 200;
    const receipt = db.prepare('SELECT request_hash,response_status,response_json FROM mutation_receipts WHERE key_hash=?').get(keyHash);
    if (receipt) {
        if (receipt.request_hash !== requestHash)
            throw new DomainError('conflict', 'Idempotency-Key was already used for a different Factory mutation');
        if (receipt.response_status !== status)
            throw new DomainError('internal', 'Invalid Factory mutation receipt');
        return JSON.parse(String(receipt.response_json)) as T;
    }
    const result = operation(), response = JSON.stringify(result);
    db.prepare('INSERT INTO mutation_receipts(key_hash,request_hash,response_status,response_json) VALUES(?,?,?,?)')
        .run(keyHash, requestHash, status, response);
    // Both the first result and replay expose the exact persisted JSON representation.
    return JSON.parse(response) as T;
}
