import {
                    
                    
} from "../../../application/request-gates.js";
                                               
import { boundedInteger, identifier, invalid, summary } from './values.js';

export function requestExecution(store              , id        , turnId        ) {
  store.get(id);
  identifier(turnId, "turn ID");
  const row = store.database()
    .prepare(
      "SELECT payload FROM request_executions WHERE request_id=? AND turn_id=?",
    )
    .get(id, turnId);
  return row
    ? (JSON.parse(String(row.payload))                
                                  
       )
    : undefined;
}

export function requestHasActiveReview(store              , sessionId        )          {
  return store.database()
    .prepare("SELECT payload FROM worker_requests WHERE session_id=?")
    .all(sessionId)
    .some((row) =>
      (JSON.parse(String(row.payload))                 ).reviews.some(
        (review) => ["queued", "running"].includes(review.status),
      ),
    );
}

export function requestForSession(store              , sessionId        )                            {
  identifier(sessionId, "session ID");
  const row = store.database()
    .prepare(
      "SELECT payload FROM worker_requests WHERE session_id=? ORDER BY sequence DESC LIMIT 1",
    )
    .get(sessionId);
  return row ? JSON.parse(String(row.payload)) : undefined;
}

export function requestForTurn(store              , sessionId        , turnId        )                            {
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
  store              ,
  options   
                       
                   
                   
                   
                    
    = {},
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
    params                      = [after];
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
      .get(...params) .count,
  );
  const rows = store.database()
    .prepare(
      `SELECT sequence,payload FROM worker_requests WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ? OFFSET ?`,
    )
    .all(...params, limit + 1, offset);
  const selected = rows.slice(0, limit);
  return {
    schemaVersion: 1         ,
    rows: selected.map((row) => summary(JSON.parse(String(row.payload)))),
    total,
    nextOffset: rows.length > limit ? offset + limit : null,
    requests: selected.map((row) => summary(JSON.parse(String(row.payload)))),
    nextAfter: selected.length ? Number(selected.at(-1) .sequence) : after,
    hasMore: rows.length > limit,
  };
}

export function requestEvents(store              , id        , after = 0, limit = 100) {
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
    schemaVersion: 1         ,
    requestId: id,
    events: selected.map(
      (row) => JSON.parse(String(row.payload))                ,
    ),
    nextAfter: selected.length ? Number(selected.at(-1) .sequence) : after,
    hasMore: rows.length > limit,
  };
}
