# Orchestrator CLI and HTTP contract — starter v0.1

Single-line HTTP base: `http://127.0.0.1:3000`; the Factory demo uses
Alpha `:3001` and Beta `:3002`. Factory has its own [API](../how-to/factory.md#factory-api-contract). JSON request bodies are limited to 64 KiB.
Use `Content-Type: application/json`. Errors are `{ "error": "description" }`.
Unknown task/registration/claim/lease fields and invalid providers are rejected.
Manual intake requires acceptance criteria; requirement-reference intake may
leave them empty in default mock mode; opt-in bound intake derives them from a
ready committed requirement. CLI commands reject unrelated flags; an
unknown option does not silently fall back to a mutating default.

Authentication is `Authorization: Bearer TOKEN`. Development admin and enrollment
tokens must be distinct and at least 24 characters. Worker registration returns
a separate opaque token that is stored locally and hashed in SQLite. Project
binding comes from the server's enrollment grant, never the worker request.

| Method / endpoint | Auth | Result / semantics |
| --- | --- | --- |
| `GET /`, `/intake` | Public shell | Intake first; data/actions require admin token |
| `GET /concept` | Public | Separate simulated 3D concept prototype |
| `GET /guide` | Public | Standalone read-only entity/navigation guide; no API calls or administrative actions |
| `GET /healthz` | Public | Process health, mock mode, DB schema version |
| `POST /v1/tasks` | Admin | Validate and enqueue; `Idempotency-Key` required |
| `POST /v1/iteration/tasks` | Admin | Explicit pinned iteration source validation; binding and idempotency key required |
| `GET /v1/tasks` | Admin | `{tasks: [...]}` |
| `GET /v1/tasks/:id` | Admin | One task or 404 |
| `GET /v1/tasks/:id/context` | Admin | Immutable source manifest for a bound task, otherwise 404 |
| `GET /v1/tasks/:id/events` | Admin | Ordered, task-scoped event history |
| `GET /v1/overview` | Admin | Line task/worker/snapshot counters consumed by Factory; unknown cost stays null |
| `GET /v1/workers` | Admin | Project, profiles, configuration, last contact; no credentials |
| `GET /v1/workers/:id` | Admin | Bounded worker/config/active-task projection in this configured project; no token/hash/lease/raw payload |
| `GET /v1/capabilities` | Admin | Versioned mock intake/context/profile capabilities and observed capacity |
| `GET /v1/snapshots` | Admin | Snapshot payloads, digests, receipt times and next cursor |
| `POST /v1/workers/register` | Enrollment | `{profiles,policy}` → worker ID/token/project |
| `GET /v1/worker/assignments/current` | Worker | Current assigned running tasks |
| `POST /v1/worker/assignments/next` | Worker | `{requestId}` → `{task: Task|null}`; atomic claim |
| `GET /v1/worker/tasks/:id/context?lease=LEASE&attempt=N` | Worker | Exact historical assignment context; no lease renewal |
| `POST /v1/worker/tasks/:id/heartbeat` | Worker | `{lease,attempt}` → task with renewed expiry |
| `POST /v1/worker/tasks/:id/complete` | Worker | Same identity; requires snapshot pair and simulated outcome |
| `POST /v1/worker/tasks/:id/abandon` | Worker | Same identity; queues retry or blocks at attempt limit |
| `POST /v1/worker/snapshots` | Worker | Snapshot → `{id,sha256}`; immutable/idempotent |

Claims use a stable request ID across network retries; choose a new ID when asking
for another slot. A replay returns that same still-active assignment, never a
second task. Concurrency counts all active tasks and profile sessions. TTL is
60 seconds; workers renew according to the assigned lease lifetime, including
while terminal snapshots and completion are being acknowledged. Server time is
authoritative.
Expired/superseded lease operations return 409. Replaying successful completion
does not create another finish event. A delayed old snapshot can be indexed as
historical telemetry but cannot complete or publish the task.

Snapshot filters: `project`, `worker`, `task`; `limit` is 1–1000 (default 500).
The default `order=asc` uses `after` (sequence cursor, default 0) for incremental
export. `order=desc` starts with the latest records and uses `before` for older
pages. Do not mix `after` and `before`. Continue with `nextCursor` in the selected
direction while `hasMore` is true. A cursor is a persistent sequence, not a
timestamp; worker capture time and server receipt time are separate fields.

The CLI accepts the equivalent `snapshots list --order desc --before CURSOR`.
A background sweep reconciles expired leases even when no new workers claim
work. The maximum attempt count is pinned for the current assignment and is
not retroactively changed with worker configuration. A later assignment may use
another worker's policy; a task-global immutable retry budget is not implemented.

All task submissions must use the orchestrator's configured project, including
unbound mock intake. `/v1/overview.capabilities` matches `/v1/capabilities`; unknown
capabilities from an older line remain unknown in Factory. See
[observability](observability.md) for exact capability/worker-detail fields,
request IDs, health semantics and structured diagnostic retention.

## Bounded collection pages

Task, worker and task-event listings support opt-in pagination:
`GET /v1/tasks?limit=100`, `GET /v1/workers?limit=100`, and
`GET /v1/tasks/:id/events?limit=100`. Supplying `limit` or `cursor` enables the
paged response. Without either parameter, the original unbounded response
shape is preserved for existing clients; those clients still need migration
before a large deployment.

A page contains the original `tasks`, `workers` or `events` array plus
`hasMore` and `nextCursor`. While `hasMore` is true, send the returned opaque
string as `cursor` on the same collection. The last page has `nextCursor: null`.
`limit` is a maximum from 1–1000, default 100. A 4 MiB serialized-item budget
can shorten a page even when fewer than `limit` records were returned; always
use `hasMore`, never the array length, to decide whether to continue. The
response envelope adds a small amount of overhead below the HTTP client's
8 MiB response cap.

Tasks retain creation-time descending / ID ascending order, including ties.
Paged workers use reverse registration order because heartbeat timestamps can
change between requests; legacy worker listings retain last-contact order.
Events use ascending sequence order. The first page fixes an insertion
watermark, so later registrations, tasks and events do not appear halfway
through a traversal. Mutable status fields reflect the time each page is read;
pagination is not a historical state snapshot. Restart without rewriting the
database preserves cursors. Start a fresh traversal after restore, database
rebuild or SQLite VACUUM, which can change internal row positions.

Cursors are validated and bound to their collection (and task for event pages).
They are continuation data, not credentials; every request still requires
admin authorization. Empty, malformed or mismatched cursors, unknown or repeated
query parameters, and noncanonical decimal numbers return 400. Snapshot query
numbers follow the same decimal validation; existing numeric snapshot cursors
retain their separate `after`/`before` contract.

CLI equivalents:

```text
task list --limit 100 [--cursor CURSOR]
workers list --limit 100 [--cursor CURSOR]
task events --id TASK_ID --limit 100 [--cursor CURSOR]
```

Iteration import automatically follows bounded task pages and rejects a
nonadvancing continuation cursor. It retains the collected inventory to match
existing features, bounded to 10,000 tasks / 16 MiB serialized inventory;
exceeding those limits fails before new submissions. See
[iteration import limits](../how-to/pinned-iteration-import.md). The
browser taskboard and MCP listing tools use bounded pages; older clients that
omit pagination parameters retain legacy unbounded mode.
No retention or automatic deletion policy is introduced.

## Requirement-reference intake

```json
{"project":"demo","requirementRef":"[[Features/Customer portal]]"}
```

`requirementRef` is one validated vault wikilink. Provider and priority are
optional (`auto`, `1`). The server derives a display title when absent, preserves
the reference in the task/context links and does not invent acceptance criteria.
The resolved note, content hash and Git commit are **not** implied by this input.
Without server context configuration, the mock runtime stores an unresolved
reference. With all three `serve --context-repo`, `--context-commit` and
`--context-vault-root` flags, the server resolves a ready requirement at that
operator-owned full commit before inserting a task. The request project must
match the server project. New bound requests accept only `project`,
`requirementRef`, and optional `provider`, `priority` and `executionMode`; title,
criteria, context, source and other fields are rejected. Missing `executionMode`
means `mock`. Explicit `executionMode: cli` requires `provider: codex`; execution
waits for an eligible operator-configured native Linux Codex worker. Selecting
live execution does not bypass context resolution or authorize publication. Bound requirements must have 1–30 criteria.
Unsupported or missing references fail before task creation. Explicit iteration
imports use [pinned mode and its dedicated endpoint](../how-to/pinned-iteration-import.md)
on bound lines; legacy import remains unbound. Both iteration-import modes create
mock tasks; explicitly live requirement-reference intake uses `POST /v1/tasks`.

Bound task responses add `context: {sha256, commit, featureId, path}`; full source
content is returned only by the authenticated context endpoints. `task context
--id TASK_ID` retrieves the admin manifest. Worker retrieval requires its current
credential and project plus an exact persisted worker/task/lease/attempt
assignment. Historical reads are allowed for audit but grant no execution
authority. Workers heartbeat before fetching and verify all hashes and metadata.
Snapshots must carry the assigned digest and committed requirement identity.

Original normalized request digests govern retries. An identical key/request
returns the first task and immutable manifest even after binding changes or
repository loss. Different input under that key returns 409. Two concurrent
resolutions commit at most one task/context/event set. Per-server resolution
concurrency is two, with an eight-second total deadline; unavailable responses
can be retried with the same key. Manifests have a 4 MiB serialized limit below
the client response cap. See [pinned context](pinned-context.md) for the exact
reference subset, migration and operational limits.

CLI shorthand: `task create --project demo --wikilink "[[Features/Customer portal]]"
--key portal-001`. Or `task create --file examples/vault-task.json --key portal-001`.
Use one form per command; `--file -` still reads a single JSON object from stdin.

## Task input

```json
{
  "project": "demo",
  "title": "Export an order as PDF",
  "criteria": ["The export includes every order line"],
  "wikilinks": ["[[specs/Order export#Rules]]"],
  "provider": "auto",
  "priority": 1
}
```

`provider`: `auto`, `claude` or `codex`. `priority`: 1 or 2. Manual `criteria`:
1–30 nonempty strings; with `requirementRef`, 0–30. `wikilinks`: up to 12 explicit links. On unbound lines references
are syntax-checked and stored without resolution. Repo imports add
`source` with feature ID, iteration ID, branch, commit, note path, specification
hash and iteration PR URL. No revision/patch API is implemented yet.

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $WERK_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-export-001' \
  --data-binary @examples/task.json
```

The equivalent CLI command is `werk-orchestrator task create --file
examples/task.json --key order-export-001`. `--file -` reads stdin. `--url`
overrides `WERK_URL`; all other behavior uses the same HTTP service.

## Worker status service

Each worker separately serves `GET /` (live HTML), `GET /status` (JSON) and
`GET /healthz` (worker readiness). It is read-only, loopback-only by default and
contains no credentials, prompt text or source code. `/healthz` returns 200 only
for `idle`/`executing`, and 503 while starting, disconnected or stopping. `/status`
remains 200 for diagnosis while that server is reachable. Readiness is not a claim
that a coding provider is connected or a task completed. CLI `werk-worker status --format html`
exports a standalone, non-updating HTML snapshot.

## Client contract and ownership

The same `/v1` commands serve webview and headless CLI clients. `task create
--file - --key STABLE_KEY` accepts one JSON object from stdin, then calls HTTP;
it never opens SQLite. Keep the key/payload unchanged when retrying an uncertain
submission. A timeout can occur after the server commits, so it is not evidence
that the task was rejected. Successful responses, event records and task reads
provide the authoritative result.

Task transition authority stays with the server. A snapshot acknowledgment only
confirms immutable evidence ingestion. Historical telemetry may be stored after
a lease expires, while completion with that lease is rejected. The worker's
status page is local operational state; the orchestrator taskboard is persisted
portfolio state. Neither endpoint is a replacement for the other.

The shared transport rejects credential-bearing URLs and cross-origin API paths,
does not follow redirects, bounds response size and uses a request timeout.
Protocol DTO types document responses for TypeScript clients; `request<T>` is
not automatic runtime schema validation of an untrusted server. HTTP adapters
map semantic application failures to status codes; CLI adapters map them to
nonzero exit codes. See the [architecture ADR](../explanation/adr-001-client-server-boundaries.md)
for replay, failure and clock boundaries.

## MCP and command selection

`werk-orchestrator overview` reads `/v1/overview`; `health` reads process health.
`mcp serve [--url URL] [--allow-writes true|false]` exposes this one configured
line through stdio, read-only by default. The Factory CLI offers a separate MCP
bridge for its registry. See [Docker Agent integration](../how-to/docker-agent.md) for
client YAML, credentials, protocol scope and explicit write enablement.

CLI clients do not accept a SQL file or arbitrary operation path. `--url` changes
the service, not the authority of the selected token. One line's admin credential
does not authorize another line. Commands produce JSON on stdout and diagnostics
on stderr (MCP stdout is protocol-only). Exit codes are 0 success, 2 input/API 4xx
or an import revision decision, and 1 operational/network failure.

## Target extensions, not implemented endpoints

Project/user authorization, live provider execution, task revision/cancellation,
drain/hot configuration, publication outbox, Git webhook verification, review
feedback and merge transitions will extend this versioned API. The concept
prototype shows those target behaviors; the starter never fabricates PR events.
