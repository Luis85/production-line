# ADR 001 — Independently deployable server and worker applications

Status: accepted for the executable mock iteration. Date: 2026-10-12.

## Context

Product teams prepare weekly feature specifications and acceptance criteria in
Obsidian project repositories. The factory must accept work through a webview or
CLI, assign project-bound workers, preserve execution evidence and remain useful
when workers or network connections fail. The first iteration uses SQLite and
must run locally or in containers with several worker processes.

## Decision

Keep independently deployable `src/factory`, `src/orchestrator`, `src/worker`
and common `src/shared`. Factory is a portfolio hierarchy/line registry with its
own database; it queries orchestrator rollups without owning their task state.
No executable imports another application's implementation. Shared code contains
contracts, input/response validation and explicitly named transport helpers;
it does not own server scheduling or worker execution. Each CLI distribution
contains its own copy of shared modules and its runtime dependencies.

The server owns task identity, project binding, claims, lease validity,
attempt ceilings, task transitions and the analytical snapshot index. The worker
owns its identity file, effective configuration, local execution, immutable
before/after evidence, retry journal and read-only status page. The worker does
not open the server database. Neither webview writes files or changes task state
by modifying a local copy of server data.

The HTTP adapter owns request parsing, credentials, route matching and status
codes. Application operations express the permitted commands and queries. Store
transactions protect persisted state; extracted policies make scheduling and
provenance checks easier to reason about. Composition roots select these concrete
implementations and own startup/cleanup. See [architecture.md](architecture.md)
for the current module map and deliberate remaining coupling.

CLI clients use the same HTTP interface as the webview and worker. `serve` is the
server entry point; `task create --file -` is a headless HTTP client reading one
JSON object. The CLI has no alternative direct-SQL mutation path. It emits data
to stdout, diagnostics to stderr and nonzero exit codes for rejected commands.

## Communication and failure semantics

| Challenge | Decision | Boundary |
| --- | --- | --- |
| Response lost after task acceptance | Replay the same idempotency key and payload | A different payload under the same key conflicts |
| Response lost after assignment | Retry the same claim request identity; reconcile current assignments on reconnect | New claim identities request new work |
| Worker dies or loses contact | Server expires the lease and queues/blocks using the assigned retry ceiling | No guarantee that execution happened only once |
| Stale worker reports | Validate task, attempt, worker and lease identity before state mutation | Historical snapshots can be accepted without authorizing completion |
| Reporting fails after execution | Replay durable terminal evidence and completion reporting | Do not rerun an adapter merely to retry reporting |
| Process dies before after-snapshot | Record recovered interruption on restart | Lost timing/resource values remain unknown |
| Git side effect in a future adapter | Lease-checked publication outbox plus remote reconciliation | SQLite cannot atomically commit a remote PR operation |

Retries provide at-least-once delivery of selected operations with application
idempotency and lease checks. They do **not** provide global exactly-once
execution. The opaque lease identity fences state changes for one assignment;
it is not a distributed monotonic fencing service. Registration is not a durable
exactly-once enrollment transaction across a worker filesystem and server SQLite:
a crash between registration and saving identity may leave an unused server
worker record. This is a lifecycle limitation to address before production.

Reported performance belongs to a declared measurement scope. A worker process
can run several attempts concurrently; its CPU/RSS cannot be presented as
exclusive feature cost. Missing cost, tokens, checks or telemetry must remain
null/not-run. Server receipt order and worker capture time answer different
questions and are retained separately.

## SQLite and deployment consequences

One orchestrator owns the local persistent database; scale worker processes.
SQLite WAL permits concurrent readers but has one writer and requires same-host
shared-memory access. Do not mount the database into workers or put it on NFS.
Short transactions, a busy timeout and bounded queries suit this first iteration.
Synchronous SQLite and unpaginated task lists remain scaling limits; large-fleet
analytics and long histories will require measured query budgets and rollups.

The HTTP timeout, request-body limit and response-size limit are separate
controls. A transport timeout is not proof that the server rejected a mutation.
Cancellation and graceful shutdown preserve local evidence where possible;
hard termination still requires recovery. Provider process isolation, service
identity/RBAC, TLS deployment and actual Git publication remain integration work.

## Alternatives and evolution

A shared filesystem task queue would couple worker availability to server storage
and weaken the authoritative API boundary. Separate database files per worker
would require state reconciliation beyond the evidence journal. PostgreSQL and
a message broker add operational components that are unnecessary for the current
single-orchestrator scope; their future introduction should preserve commands,
identity and evidence contracts.

Application operations depend on explicit repository/worker ports, and semantic
errors no longer import HTTP status codes. The Store still combines transactional
persistence with state-transition decisions; this is not a full independent
domain model. Move dependencies only when the boundary has a clear
consumer or testing need. Avoid interfaces that simply mirror every SQLite
method, and avoid putting application behavior into a generic shared utility.

## References and interpretation

- [RFC 9110, §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2):
  HTTP method idempotency informs retry safety. Werk's POST idempotency is an
  application contract, not an automatic property of POST.
- [SQLite WAL](https://www.sqlite.org/wal.html): concurrency and same-host storage
  constraints justify a single database owner in this deployment.
- [Node 24 HTTP server API](https://nodejs.org/docs/latest-v24.x/api/http.html):
  server request/header timeouts and connection shutdown are transport concerns.

These references support the constraints above. The chosen application module
boundaries and recovery policy are Werk design decisions, not requirements
imposed by those documents.
