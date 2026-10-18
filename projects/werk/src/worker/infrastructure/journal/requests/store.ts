import { randomUUID } from "node:crypto";
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from "../../../../shared/errors.js";
import {
  gateDigest,
  type RequestEvent,
  type WorkerRequest
} from "../../../application/request-gates.js";
import { openPrivateJournal } from '../database.js';
import { conflict, identifier, iso } from './values.js';

export class RequestStore {
  private db?: DatabaseSync;
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async init() {
    if (this.db) return;
    await this.open();
    try { this.recover(); } catch (error) { this.close(); throw error; }
  }
  async open() {
    if (this.db) return;
    this.db = await openPrivateJournal(this.directory, 'worker-requests.sqlite', 'Request journal must be a regular file.');
    try {
      this.db
        .exec(`
        CREATE TABLE IF NOT EXISTS worker_requests(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,root_turn_id TEXT NOT NULL,phase TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(session_id,root_turn_id));
        CREATE TABLE IF NOT EXISTS request_generations(request_id TEXT NOT NULL,input_revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(request_id,input_revision));
        CREATE TABLE IF NOT EXISTS request_turns(session_id TEXT NOT NULL,turn_id TEXT NOT NULL,request_id TEXT NOT NULL,input_revision INTEGER NOT NULL,PRIMARY KEY(session_id,turn_id));
        CREATE TABLE IF NOT EXISTS request_executions(request_id TEXT NOT NULL,turn_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(request_id,turn_id));
        CREATE TABLE IF NOT EXISTS request_operations(request_id TEXT NOT NULL,operation_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(request_id,operation_id));
        CREATE TABLE IF NOT EXISTS request_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS request_events_owner ON request_events(request_id,sequence);
        CREATE INDEX IF NOT EXISTS request_sessions ON worker_requests(session_id,sequence);
        CREATE TABLE IF NOT EXISTS request_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS request_policy_operations(operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL);`);
    } catch (error) { this.close(); throw error; }
  }
  recover(retained: ReadonlySet<string> = new Set()) {
      for (const row of this.database()
        .prepare("SELECT payload FROM worker_requests")
        .all()) {
        const request = JSON.parse(String(row.payload)) as WorkerRequest;
        let changed = false;
        if (
          request.execution &&
          ["prepared", "running"].includes(request.execution.status) &&
          !request.execution.result &&
          !(retained.has(request.id) && this.preparedForRecovery(request.id))
        ) {
          request.execution.status = "interrupted";
          request.execution.outcome = "interrupted";
          request.phase = "interrupted";
          changed = true;
        }
        for (const review of request.reviews)
          if (review.status === "running") {
            review.status = "interrupted";
            review.errorCode = "worker_restarted";
            review.finishedAt = iso();
            changed = true;
          }
        if (changed)
          this.transaction(() => this.save(request, "recovered_interrupted"));
      }
  }
  preparedForRecovery(id: string): boolean {
    const db = this.database(), request = this.get(id), execution = request.execution;
    if (!execution || execution.status !== 'prepared') return false;
    const row = db.prepare('SELECT session_id,root_turn_id,phase FROM worker_requests WHERE id=?').get(id);
    const bound = db.prepare('SELECT request_id,input_revision FROM request_turns WHERE session_id=? AND turn_id=?').get(request.owner.sessionId, execution.turnId);
    const saved = db.prepare('SELECT payload FROM request_executions WHERE request_id=? AND turn_id=?').get(id, execution.turnId);
    const generation = db.prepare('SELECT payload FROM request_generations WHERE request_id=? AND input_revision=?').get(id, request.inputRevision);
    if (!generation) return false;
    const accepted = JSON.parse(String(generation.payload));
    if (['input', 'inputHash', 'policy', 'policyDigest', 'provider'].some(key => gateDigest(accepted[key]) !== gateDigest(request[key as keyof WorkerRequest]))) return false;
    const started = db.prepare("SELECT 1 FROM request_events WHERE request_id=? AND json_extract(payload,'$.turnId')=? AND json_extract(payload,'$.type')='execution_started' LIMIT 1").get(id, execution.turnId);
    return row?.session_id === request.owner.sessionId && row.root_turn_id === request.owner.rootTurnId && row.phase === request.phase &&
      bound?.request_id === id && bound.input_revision === request.inputRevision && !!saved && JSON.stringify(JSON.parse(String(saved.payload))) === JSON.stringify(execution) && !started;
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
  database() {
    if (!this.db) throw Error("Request journal is not open.");
    return this.db;
  }
  transaction<T>(action: () => T): T {
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  save(
    request: WorkerRequest,
    type: string,
    detail: Pick<RequestEvent, "evaluationId" | "turnId" | "runId"> = {},
  ) {
    request.revision++;
    request.updatedAt = iso();
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload) > 16777216)
      conflict(
        "Request history reached its bounded private record size. Create a linked new request.",
      );
    this.database()
      .prepare("UPDATE worker_requests SET phase=?,payload=? WHERE id=?")
      .run(request.phase, payload, request.id);
    if (request.execution) {
      const previous = this.database()
        .prepare(
          "SELECT payload FROM request_executions WHERE request_id=? AND turn_id=?",
        )
        .get(request.id, request.execution.turnId);
      if (previous) {
        const retained = JSON.parse(String(previous.payload));
        if (
          retained.result &&
          retained.outputDigest !== request.execution.outputDigest
        )
          conflict("A historical execution result is immutable.");
      }
      this.database()
        .prepare(
          "INSERT INTO request_executions(request_id,turn_id,payload) VALUES(?,?,?) ON CONFLICT(request_id,turn_id) DO UPDATE SET payload=excluded.payload",
        )
        .run(
          request.id,
          request.execution.turnId,
          JSON.stringify(request.execution),
        );
    }
    const event: RequestEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      sequence: 0,
      requestId: request.id,
      revision: request.revision,
      type,
      phase: request.phase,
      at: request.updatedAt,
      inputRevision: request.inputRevision,
      ...detail,
    };
    const result = this.database()
      .prepare(
        "INSERT INTO request_events(id,request_id,payload) VALUES(?,?,?)",
      )
      .run(event.id, request.id, "{}");
    event.sequence = Number(result.lastInsertRowid);
    this.database()
      .prepare("UPDATE request_events SET payload=? WHERE sequence=?")
      .run(JSON.stringify(event), event.sequence);
  }
  generation(request: WorkerRequest) {
    this.database()
      .prepare(
        "INSERT INTO request_generations(request_id,input_revision,payload) VALUES(?,?,?)",
      )
      .run(
        request.id,
        request.inputRevision,
        JSON.stringify({
          input: request.input,
          inputHash: request.inputHash,
          policy: request.policy,
          policyDigest: request.policyDigest,
          provider: request.provider,
          at: request.updatedAt,
        }),
      );
  }
  get(id: string): WorkerRequest {
    identifier(id, "request ID");
    const row = this.database()
      .prepare("SELECT payload FROM worker_requests WHERE id=?")
      .get(id);
    if (!row) throw new DomainError("not_found", "Request not found.");
    return JSON.parse(String(row.payload));
  }
  deleteSession(sessionId: string) {
    identifier(sessionId, "session ID");
    this.transaction(() => {
      const rows = this.database()
        .prepare("SELECT id FROM worker_requests WHERE session_id=?")
        .all(sessionId);
      for (const row of rows)
        for (const table of [
          "request_generations",
          "request_executions",
          "request_turns",
          "request_operations",
          "request_events",
        ])
          this.database()
            .prepare(`DELETE FROM ${table} WHERE request_id=?`)
            .run(row.id!);
      this.database()
        .prepare("DELETE FROM worker_requests WHERE session_id=?")
        .run(sessionId);
    });
  }
}
