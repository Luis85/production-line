import type { DatabaseSync } from "node:sqlite";
import { workerPolicy } from "../../shared/contracts.js";
export const SCHEMA_VERSION = 6;
/** Called inside the store's startup transaction; never commits partial upgrades. */
export function migrateSchema(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as any).user_version;
  if (version > SCHEMA_VERSION)
    throw Error("Database schema is newer than this application");
  db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL,
        priority INTEGER NOT NULL, created INTEGER NOT NULL, idem TEXT UNIQUE NOT NULL,
        digest TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
        worker TEXT, lease TEXT, expires INTEGER, profile TEXT
      );
      CREATE TABLE IF NOT EXISTS task_contexts (
        task TEXT PRIMARY KEY REFERENCES tasks(id), sha256 TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS task_contexts_immutable_update BEFORE UPDATE ON task_contexts
        BEGIN SELECT RAISE(ABORT, 'Task context is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS task_contexts_immutable_delete BEFORE DELETE ON task_contexts
        BEGIN SELECT RAISE(ABORT, 'Task context is immutable'); END;
      CREATE INDEX IF NOT EXISTS scheduling ON tasks(status, priority DESC, created);
      CREATE INDEX IF NOT EXISTS task_listing ON tasks(created DESC,id);
      CREATE INDEX IF NOT EXISTS scheduling_project_priority ON tasks(json_extract(payload,'$.project'),priority DESC,created,id) WHERE status='queued';
      CREATE INDEX IF NOT EXISTS scheduling_project_fifo ON tasks(json_extract(payload,'$.project'),created,id) WHERE status='queued';
      CREATE INDEX IF NOT EXISTS running_expiry ON tasks(expires) WHERE status='running';
      CREATE INDEX IF NOT EXISTS running_worker ON tasks(worker) WHERE status='running';
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, profiles TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL, seen INTEGER NOT NULL, config TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events(task,seq);
      CREATE INDEX IF NOT EXISTS events_monitoring_window ON events(kind,at,task);
      CREATE TABLE IF NOT EXISTS attempts (
        task TEXT NOT NULL, attempt INTEGER NOT NULL, worker TEXT NOT NULL, lease TEXT NOT NULL UNIQUE,
        profile TEXT NOT NULL, claim_key TEXT NOT NULL, config_hash TEXT NOT NULL,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        PRIMARY KEY(task,attempt), UNIQUE(worker,claim_key)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, task TEXT NOT NULL, attempt INTEGER NOT NULL, phase TEXT NOT NULL,
        worker TEXT NOT NULL, project TEXT NOT NULL, captured TEXT NOT NULL, received INTEGER NOT NULL,
        digest TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(task,attempt,phase)
      );
      CREATE INDEX IF NOT EXISTS snapshot_timeseries ON snapshots(project,received);
      `);
  // Inspect columns so an interrupted legacy migration can be safely resumed.
  const columns = (table: string) =>
    db
      .prepare("PRAGMA table_info(" + table + ")")
      .all()
      .map((c: any) => c.name);
  if (!columns("workers").includes("config"))
    db.exec("ALTER TABLE workers ADD COLUMN config TEXT NOT NULL DEFAULT '{}'");
  db.prepare("UPDATE workers SET config=? WHERE config='{}'").run(
    JSON.stringify(workerPolicy()),
  );
  if (!columns("attempts").includes("max_attempts")) {
    db.exec(
      "ALTER TABLE attempts ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3",
    );
    db.exec(
      "UPDATE attempts SET max_attempts=COALESCE((SELECT json_extract(config,'$.maxAttempts') FROM workers WHERE workers.id=attempts.worker),3)",
    );
  }
  db.exec(`CREATE TABLE IF NOT EXISTS routing_policy(project TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_routing(task TEXT PRIMARY KEY REFERENCES tasks(id),worker TEXT NOT NULL REFERENCES workers(id));
      CREATE TABLE IF NOT EXISTS task_successors (
        parent TEXT NOT NULL REFERENCES tasks(id), attempt INTEGER NOT NULL, evaluation TEXT NOT NULL,
        operation_id TEXT NOT NULL, digest TEXT NOT NULL, child TEXT NOT NULL UNIQUE REFERENCES tasks(id),
        PRIMARY KEY(parent,operation_id), UNIQUE(parent,attempt,evaluation)
      );
      PRAGMA user_version=6;`);
}
