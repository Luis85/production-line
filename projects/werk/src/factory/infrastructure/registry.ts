import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import type { Factory, ProductionLine } from '../../shared/factory.js';
import type { FactoryRegistry } from '../application/ports.js';
import type { FactoryMutation, MutationResult } from '../application/mutations.js';
import { withMutationReceipt } from './idempotency.js';
import { migrateFactoryRegistry } from './schema.js';
/** Registry only: never reads another application's database or controls its lifecycle. */
export class SqliteFactoryRegistry implements FactoryRegistry {
    private readonly db: DatabaseSync;
    constructor(path: string) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        try {
            // Install the bounded busy handler before journal-mode negotiation or schema locks.
            this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
            this.transaction(() => migrateFactoryRegistry(this.db));
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    close() { this.db.close(); }
    mutation<T extends MutationResult>(intent: FactoryMutation, operation: () => T): T {
        return this.transaction(() => withMutationReceipt(this.db, intent, operation));
    }
    private transaction<T>(operation: () => T): T {
        // CRUD called by a receipt operation shares its transaction and rollback boundary.
        if (this.db.isTransaction) return operation();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = operation();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    factories(): Factory[] { return this.db.prepare('SELECT id,name,parent_id AS parentId FROM factories ORDER BY name,id').all() as unknown as Factory[]; }
    factory(id: string): Factory {
        const value = this.db.prepare('SELECT id,name,parent_id AS parentId FROM factories WHERE id=?').get(id) as unknown as Factory | undefined;
        if (!value)
            throw new DomainError('not_found', 'Factory not found');
        return value;
    }
    private assertValidParent(id: string, parentId: string | null) {
        let cursor = parentId;
        const visited = new Set<string>([id]);
        while (cursor !== null) {
            if (visited.has(cursor))
                throw new DomainError('conflict', 'Factory hierarchy cannot contain a cycle');
            visited.add(cursor);
            cursor = this.factory(cursor).parentId;
        }
    }
    createFactory(value: Omit<Factory, 'id'> & {
        id?: string;
    }): Factory {
        return this.transaction(() => {
            const id = value.id ?? randomUUID();
            if (this.db.prepare('SELECT id FROM factories WHERE id=?').get(id))
                throw new DomainError('conflict', 'Factory ID already exists');
            this.assertValidParent(id, value.parentId);
            this.db.prepare('INSERT INTO factories(id,name,parent_id) VALUES(?,?,?)').run(id, value.name, value.parentId);
            return this.factory(id);
        });
    }
    updateFactory(id: string, value: Omit<Factory, 'id'>): Factory {
        return this.transaction(() => {
            this.factory(id);
            this.assertValidParent(id, value.parentId);
            this.db.prepare('UPDATE factories SET name=?,parent_id=? WHERE id=?').run(value.name, value.parentId, id);
            return this.factory(id);
        });
    }
    deleteFactory(id: string) {
        this.transaction(() => {
            this.factory(id);
            if (this.db.prepare('SELECT id FROM factories WHERE parent_id=? LIMIT 1').get(id) || this.db.prepare('SELECT id FROM lines WHERE factory_id=? LIMIT 1').get(id))
                throw new DomainError('conflict', 'Move or remove child factories and production lines before deleting this factory');
            this.db.prepare('DELETE FROM factories WHERE id=?').run(id);
        });
    }
    lines(): ProductionLine[] { return this.db.prepare('SELECT id,name,factory_id AS factoryId,orchestrator_url AS orchestratorUrl,webview_url AS webviewUrl,token_env AS tokenEnv FROM lines ORDER BY name,id').all() as unknown as ProductionLine[]; }
    line(id: string): ProductionLine {
        const value = this.db.prepare('SELECT id,name,factory_id AS factoryId,orchestrator_url AS orchestratorUrl,webview_url AS webviewUrl,token_env AS tokenEnv FROM lines WHERE id=?').get(id) as unknown as ProductionLine | undefined;
        if (!value)
            throw new DomainError('not_found', 'Production line not found');
        return value;
    }
    private assertUniqueEndpoint(url: string, id: string) {
        if (this.db.prepare('SELECT id FROM lines WHERE orchestrator_url=? AND id<>?').get(url, id))
            throw new DomainError('conflict', 'This orchestrator is already registered as a production line');
    }
    createLine(value: Omit<ProductionLine, 'id'> & {
        id?: string;
    }): ProductionLine {
        return this.transaction(() => {
            const id = value.id ?? randomUUID();
            if (this.db.prepare('SELECT id FROM lines WHERE id=?').get(id))
                throw new DomainError('conflict', 'Line ID already exists');
            this.factory(value.factoryId);
            this.assertUniqueEndpoint(value.orchestratorUrl, id);
            this.db.prepare('INSERT INTO lines(id,name,factory_id,orchestrator_url,webview_url,token_env) VALUES(?,?,?,?,?,?)').run(id, value.name, value.factoryId, value.orchestratorUrl, value.webviewUrl, value.tokenEnv);
            return this.line(id);
        });
    }
    updateLine(id: string, value: Omit<ProductionLine, 'id'>): ProductionLine {
        return this.transaction(() => {
            this.line(id);
            this.factory(value.factoryId);
            this.assertUniqueEndpoint(value.orchestratorUrl, id);
            this.db.prepare('UPDATE lines SET name=?,factory_id=?,orchestrator_url=?,webview_url=?,token_env=? WHERE id=?').run(value.name, value.factoryId, value.orchestratorUrl, value.webviewUrl, value.tokenEnv, id);
            return this.line(id);
        });
    }
    deleteLine(id: string) {
        this.transaction(() => {
            this.line(id);
            this.db.prepare('DELETE FROM lines WHERE id=?').run(id);
        });
    }
}
