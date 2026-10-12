import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../shared/errors.js';

export const FACTORY_SCHEMA_VERSION = 2;
/** Migration is called inside one registry transaction; receipts outlive deleted resources. */
export function migrateFactoryRegistry(db: DatabaseSync): void {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > FACTORY_SCHEMA_VERSION)
        throw new DomainError('internal', 'Factory registry schema is newer than this application');
    db.exec(`
        CREATE TABLE IF NOT EXISTS factories(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT REFERENCES factories(id));
        CREATE TABLE IF NOT EXISTS lines(id TEXT PRIMARY KEY,name TEXT NOT NULL,factory_id TEXT NOT NULL REFERENCES factories(id),orchestrator_url TEXT NOT NULL UNIQUE,webview_url TEXT NOT NULL,token_env TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS factory_parent ON factories(parent_id);
        CREATE INDEX IF NOT EXISTS line_factory ON lines(factory_id);
        CREATE TABLE IF NOT EXISTS mutation_receipts(key_hash TEXT PRIMARY KEY,request_hash TEXT NOT NULL,response_status INTEGER NOT NULL CHECK(response_status IN (200,201)),response_json TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS mutation_receipts_no_update BEFORE UPDATE ON mutation_receipts BEGIN SELECT RAISE(ABORT,'Factory mutation receipts are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS mutation_receipts_no_delete BEFORE DELETE ON mutation_receipts BEGIN SELECT RAISE(ABORT,'Factory mutation receipts are immutable'); END;
        PRAGMA user_version=2;
    `);
}
