import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../../shared/contracts.js";
import type { WorkerRecord } from "../../shared/protocol.js";

/** One live connection and transaction owner shared by focused persistence operations. */
export interface StoreSession {
  readonly db: DatabaseSync;
  readonly ttl: number;
  clock(): number;
  transaction<T>(operation: () => T): T;
  event(task: string, kind: string, detail: unknown): void;
  get(id: string): Task;
  decode(row: any): Task;
  reapExpired(): number;
  reapExpiredInsideTransaction(): number;
  attemptLimit(task: string, attempt: number): number;
  checkLease(task: Task, worker: WorkerRecord, lease: unknown, attempt: unknown): void;
}

/** Resolve facade members at call time so the injected clock and connection stay live. */
export function createStoreSession(
  owner: Omit<StoreSession, "reapExpiredInsideTransaction" | "attemptLimit">,
  leases: Pick<StoreSession, "reapExpiredInsideTransaction" | "attemptLimit">,
): StoreSession {
  return {
    get db() { return owner.db; },
    get ttl() { return owner.ttl; },
    clock: () => owner.clock(),
    transaction: operation => owner.transaction(operation),
    event: (task, kind, detail) => owner.event(task, kind, detail),
    get: id => owner.get(id),
    decode: row => owner.decode(row),
    reapExpired: () => owner.reapExpired(),
    reapExpiredInsideTransaction: () => leases.reapExpiredInsideTransaction(),
    attemptLimit: (task, attempt) => leases.attemptLimit(task, attempt),
    checkLease: (task, worker, lease, attempt) => owner.checkLease(task, worker, lease, attempt),
  };
}
