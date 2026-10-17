import { validateSnapshot } from "../../shared/snapshots.js";
import { DomainError } from "../../shared/errors.js";
import { assertSnapshotAssignment } from "../policies.js";
import type {
  WorkerRecord,
  SnapshotRecord,
  SnapshotAcknowledgement,
  SnapshotQuery,
} from "../../shared/protocol.js";
import type { StoreSession } from "./session.js";
import { hash } from "./digest.js";

/** Immutable assignment evidence and snapshot pagination. */
export class SnapshotRepository {
  private readonly session: StoreSession;

  constructor(session: StoreSession) {
    this.session = session;
  }

  snapshot(w: WorkerRecord, value: unknown): SnapshotAcknowledgement {
    const s = validateSnapshot(value);
    const body = JSON.stringify(s),
      digest = hash(body);
    return this.session.transaction(() => {
      const a = this.session.db
        .prepare("SELECT * FROM attempts WHERE task=? AND attempt=?")
        .get(s.taskId, s.attempt) as any;
      const task = this.session.get(s.taskId);
      assertSnapshotAssignment(
        s,
        task,
        a
          ? {
              workerId: a.worker,
              leaseId: a.lease,
              profileId: a.profile,
              configurationHash: a.config_hash,
              provider: a.provider,
              mode: a.mode,
            }
          : undefined,
        w,
      );
      const old = this.session.db
        .prepare(
          "SELECT digest FROM snapshots WHERE task=? AND attempt=? AND phase=?",
        )
        .get(s.taskId, s.attempt, s.phase) as any;
      if (old) {
        if (old.digest !== digest)
          throw new DomainError(
            "conflict",
            "Immutable snapshot already exists",
          );
        return { id: s.id, sha256: digest };
      }
      if (s.phase === "after") {
        const before = this.session.db
          .prepare(
            "SELECT captured,payload FROM snapshots WHERE task=? AND attempt=? AND phase='before'",
          )
          .get(s.taskId, s.attempt) as any;
        if (!before)
          throw new DomainError(
            "conflict",
            "Before snapshot must arrive first",
          );
        if (
          s.provenance.systemPromptHash !==
          JSON.parse(before.payload).provenance.systemPromptHash
        )
          throw new DomainError(
            "invalid_input",
            "Snapshot pair system prompt hash mismatch",
          );
        if (Date.parse(s.capturedAt) < Date.parse(before.captured))
          throw new DomainError(
            "invalid_input",
            "After snapshot predates before snapshot",
          );
      }
      this.session.db
        .prepare(
          "INSERT INTO snapshots(id,task,attempt,phase,worker,project,captured,received,digest,payload) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          s.id,
          s.taskId,
          s.attempt,
          s.phase,
          w.id,
          w.project,
          s.capturedAt,
          this.session.clock(),
          digest,
          body,
        );
      this.session.event(s.taskId, "snapshot_received", {
        id: s.id,
        phase: s.phase,
        sha256: digest,
        attempt: s.attempt,
      });
      return { id: s.id, sha256: digest };
    });
  }
  snapshots(query: SnapshotQuery = {}): SnapshotRecord[] {
    const limit = query.limit ?? 500,
      descending = query.order === "desc";
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001)
      throw new DomainError("invalid_input", "Snapshot limit: 1–1001");
    if (query.order !== undefined && !["asc", "desc"].includes(query.order))
      throw new DomainError("invalid_input", "Snapshot order: asc or desc");
    if (
      (descending && query.after !== undefined) ||
      (!descending && query.before !== undefined)
    )
      throw new DomainError(
        "invalid_input",
        "Use after with ascending order or before with descending order",
      );
    const cursor = descending
      ? (query.before ?? Number.MAX_SAFE_INTEGER)
      : (query.after ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new DomainError(
        "invalid_input",
        "Snapshot cursor must be nonnegative",
      );
    return this.session.db
      .prepare(
        "SELECT rowid AS seq,* FROM snapshots WHERE rowid" +
          (descending ? "<" : ">") +
          "? AND (? IS NULL OR project=?) AND (? IS NULL OR worker=?) AND (? IS NULL OR task=?) ORDER BY rowid " +
          (descending ? "DESC" : "ASC") +
          " LIMIT ?",
      )
      .all(
        cursor,
        query.project ?? null,
        query.project ?? null,
        query.worker ?? null,
        query.worker ?? null,
        query.task ?? null,
        query.task ?? null,
        limit,
      )
      .map((r: any) => ({
        seq: r.seq,
        snapshot: JSON.parse(r.payload),
        sha256: r.digest,
        receivedAt: new Date(r.received).toISOString(),
      }));
  }
}
