import { releasePending } from '../../../application/release-contracts.js';
import type { ReservedExecutionPermit } from '../../../application/serial-executor.js';
import {
  type RequestEvent,
  type WorkerRequest
} from "../../../application/request-gates.js";
import type { RequestStore } from './store.js';
import { boundedInteger, identifier, invalid, summary } from './values.js';

export function requestExecution(store: RequestStore, id: string, turnId: string) {
  store.get(id);
  identifier(turnId, "turn ID");
  const row = store.database()
    .prepare(
      "SELECT payload FROM request_executions WHERE request_id=? AND turn_id=?",
    )
    .get(id, turnId);
  return row
    ? (JSON.parse(String(row.payload)) as NonNullable<
        WorkerRequest["execution"]
      >)
    : undefined;
}

export function requestHasActiveReview(store: RequestStore, sessionId: string): boolean {
  return store.database()
    .prepare("SELECT payload FROM worker_requests WHERE session_id=?")
    .all(sessionId)
    .some((row) => {
      const request = JSON.parse(String(row.payload)) as WorkerRequest;
      return releasePending(request.delivery?.release) || !!request.delivery?.release?.merge && !request.delivery.release.published
        || request.reviews.some(review => ["queued", "running"].includes(review.status));
    });
}

export function requestForSession(store: RequestStore, sessionId: string): WorkerRequest | undefined {
  identifier(sessionId, "session ID");
  const row = store.database()
    .prepare(
      "SELECT payload FROM worker_requests WHERE session_id=? ORDER BY sequence DESC LIMIT 1",
    )
    .get(sessionId);
  return row ? JSON.parse(String(row.payload)) : undefined;
}

export function requestForTurn(store: RequestStore, sessionId: string, turnId: string): WorkerRequest | undefined {
  identifier(sessionId, "session ID");
  identifier(turnId, "turn ID");
  const row = store.database()
    .prepare(
      "SELECT request_id FROM request_turns WHERE session_id=? AND turn_id=?",
    )
    .get(sessionId, turnId);
  if (row) return store.get(String(row.request_id));
  const root = store.database()
    .prepare(
      "SELECT payload FROM worker_requests WHERE session_id=? AND root_turn_id=?",
    )
    .get(sessionId, turnId);
  return root ? JSON.parse(String(root.payload)) : undefined;
}

export function requestList(
  store: RequestStore,
  options: {
    sessionId?: string;
    phase?: string;
    limit?: number;
    after?: number;
    offset?: number;
  } = {},
) {
  const offset = boundedInteger(
    options.offset,
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (options.offset !== undefined && options.after !== undefined)
    invalid("Choose offset or after pagination, not both.");
  const limit = boundedInteger(options.limit, 50, 1, 100),
    after = boundedInteger(options.after, 0, 0, Number.MAX_SAFE_INTEGER);
  if (options.sessionId !== undefined)
    identifier(options.sessionId, "session ID");
  if (
    options.phase !== undefined &&
    ![
      "readiness",
      "needs_rework",
      "ready",
      "running",
      "waiting_input",
      "escalated",
      "review",
      "done",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(options.phase)
  )
    invalid("Unknown request phase.");
  const clauses = ["sequence>?"],
    params: (string | number)[] = [after];
  if (options.sessionId) {
    clauses.push("session_id=?");
    params.push(options.sessionId);
  }
  if (options.phase) {
    clauses.push("phase=?");
    params.push(options.phase);
  }
  const total = Number(
    store.database()
      .prepare(
        `SELECT COUNT(*) AS count FROM worker_requests WHERE ${clauses.join(" AND ")}`,
      )
      .get(...params)!.count,
  );
  const rows = store.database()
    .prepare(
      `SELECT sequence,payload FROM worker_requests WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ? OFFSET ?`,
    )
    .all(...params, limit + 1, offset);
  const selected = rows.slice(0, limit);
  return {
    schemaVersion: 1 as const,
    rows: selected.map((row) => summary(JSON.parse(String(row.payload)))),
    total,
    nextOffset: rows.length > limit ? offset + limit : null,
    requests: selected.map((row) => summary(JSON.parse(String(row.payload)))),
    nextAfter: selected.length ? Number(selected.at(-1)!.sequence) : after,
    hasMore: rows.length > limit,
  };
}

export function requestEvents(store: RequestStore, id: string, after = 0, limit = 100) {
  store.get(id);
  after = boundedInteger(after, 0, 0, Number.MAX_SAFE_INTEGER);
  limit = boundedInteger(limit, 100, 1, 100);
  const rows = store.database()
    .prepare(
      "SELECT payload,sequence FROM request_events WHERE request_id=? AND sequence>? ORDER BY sequence LIMIT ?",
    )
    .all(id, after, limit + 1);
  const selected = rows.slice(0, limit);
  return {
    schemaVersion: 1 as const,
    requestId: id,
    events: selected.map(
      (row) => JSON.parse(String(row.payload)) as RequestEvent,
    ),
    nextAfter: selected.length ? Number(selected.at(-1)!.sequence) : after,
    hasMore: rows.length > limit,
  };
}

/** Unknown process outcomes retain execution capacity independently of session catalog pagination. */
export function requestUnresolvedExecutions(store: RequestStore): ReservedExecutionPermit[] {
  const rows = store.database().prepare(`SELECT payload FROM worker_requests WHERE
    json_extract(payload, '$.delivery.status') IN ('outcome_unknown', 'reconciling', 'interrupting')
    OR EXISTS (SELECT 1 FROM json_each(payload, '$.delivery.steps') WHERE json_extract(value, '$.status')='outcome_unknown')`).all();
  return rows.map(row => {
    const request = JSON.parse(String(row.payload)) as WorkerRequest;
    const context = request.input.context as { repositoryId?: unknown; repository?: unknown; deliveryPolicy?: { configuration?: { coordination?: { maxActiveRequests?: unknown } } } } | undefined;
    const project = context?.repositoryId ?? context?.repository, limit = context?.deliveryPolicy?.configuration?.coordination?.maxActiveRequests;
    return { sessionId: request.owner.sessionId, projectId: typeof project === 'string' && !!project.trim() && project.length <= 4096 ? project : null,
      projectLimit: Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= 8 ? Number(limit) : 1 };
  });
}
