# Architecture and delivery workflow

This document distinguishes the current runtime from the target delivery
workflow. Simulation is the default; an opt-in native Linux Codex adapter creates
a local patch for human review. Git publication, review/rework and merge tracking
remain operator actions or future integration work. See [execution modes](modes.md)
for the adapter's scope and qualification limits. The [client/server ADR](adr-001-client-server-boundaries.md) records
ownership, retry/fencing semantics and deployment tradeoffs. The
[UI journey](ui-journey.md) maps the same boundaries to user-facing behavior.


The imported handoff's [technical contracts](../handoff/technical-contracts.md)
and [readiness audit](../handoff/readiness.md) record the original baseline and
requirement IDs. Later work updates that baseline; use the current
[API reference](../reference/api.md) and [documentation hub](../index.md) for
implemented contracts and operating procedures.

## Portfolio hierarchy above independent lines

`src/factory` is a third standalone application with its own CLI, HTTP webview
and SQLite registry. It owns factory records, logical parent/child relationships,
stable line registrations and read-only rollups. Each line points to an
independent orchestrator; tasks, workers, leases and evidence remain inside it.
A project is a repository/context binding inside a line, not the line itself.

The hierarchy is logical within one Factory service in this iteration. It is not
cross-server federation. An unavailable line produces an explicit partial
rollup; its missing counters are not zero. Factory contains server-side
credential references and uses its configured credentials when reading lines;
the browser receives no line secret. See [Factory setup](../how-to/factory.md).

The original `src/orchestrator`/`src/worker` separation remains. Existing line
runtimes can be deployed without Factory, and Factory neither opens their
SQLite files nor routes their tasks to alternate lines. Current Factory rollups
are fresh observations, not a persisted cross-line timeseries; only hierarchy
and line registrations are stored there.

## Target source of truth and branch relationship

The product team authors requirements, designs, concepts, specifications and
acceptance tests in its project repository using Obsidian. Weekly planning
creates an iteration branch and a draft integration PR. Features explicitly
marked ready become factory tasks. The team can then prepare the next iteration
without modifying the pinned specification of work already in execution.

| Object | Base / destination | Completion meaning |
| --- | --- | --- |
| Iteration PR | `iteration/2026-W42` → `main` | Integration/release decision by product team |
| Feature PR | `factory/REQ-241` → `iteration/2026-W42` | Delivery of one feature |
| Review rework | Same feature branch and PR | New attempt, new snapshot pair |
| Task | Feature ID + iteration + project | Done only after verified feature-PR merge |

The feature PR targets the iteration branch, which contains its specifications
and tests. Merging it completes its task; it does not imply that the iteration
has reached main or production. Report those portfolio outcomes separately.

## Target execution sequence

1. Team plans and commits the iteration; creates an iteration draft PR.
2. Importer reads committed Obsidian properties, validates feature identity and
   acceptance criteria, resolves required wiki context, and pins the Git commit.
3. Scheduler atomically leases the task to a compatible project worker/profile.
   Machine, profile and shared subscription quota limits must all allow execution.
4. Worker creates an isolated feature worktree/branch from the pinned iteration
   commit. It records the before snapshot. A first snapshot commit provides a
   real diff, allowing the feature draft PR to be opened immediately.
5. Provider adapter implements the feature using the full repository context,
   agreed system prompt, skills and allowed tools. Host-controlled steps enforce
   leases, timeouts, workspace bounds, checks and publication rules.
6. Worker executes project checks and records the after snapshot. Its code and
   snapshot artifacts are published to that feature PR. CI must validate the
   current head; only then does the PR become ready and request human review.
7. Review feedback creates a new implementation attempt. Prefer the same worker
   when available, but retain branch, PR, specification revision and repository
   identity if another authorized project worker takes over. Never transfer a
   native Claude/Codex session to another provider.
8. A push invalidates previous head-specific checks/approval. Address review
   threads, rerun checks, capture another snapshot pair and request review again.
9. Human acceptance enables merge. Only a verified merged event for the bound
   feature PR marks the task done. Closed-without-merge is a decision state.

Product planning for the next iteration uses its own branch. Dependencies between
features and changes to the iteration base require explicit ordering/rebase work;
the scheduler must not assume that independent-looking features cannot conflict.

## Server, worker and shared modules

`src/orchestrator` owns the task state, HTTP API, webview, SQLite store, scheduling
and analysis index. Its CLI is both a server entry point and a headless HTTP
client. Intake remains the first webview page; repository import is the primary
workflow and manual submissions are exceptions.

`src/worker` owns polling, the execution adapter boundary, local journals,
configuration, snapshots and a read-only local HTML status service. Mock execution
supports concurrent slots. The opt-in native Linux Codex adapter uses one slot
and one attempt, creates a disposable local checkout from a pinned commit and
manages provider cancellation and process-group cleanup. Its exact file allowlist
and host-account trust boundary are described in the
[live workflow](../how-to/run-codex-task.md). Concurrent live providers and the
target feature-branch/PR lifecycle remain future integration work.

`src/shared` owns versioned contracts and validators. It imports neither server
nor worker. The build copies shared code into each independent CLI distribution.

Source folders group application policy, persistence, intake, context, HTTP infrastructure, journals and status by concern. Composition and CLI entrypoints stay at each package root; shared contracts remain independent. Tests mirror their primary concern under `tests/`; see the [test suite guide](../../tests/README.md).

## Implemented dependency map

| Module | Responsibility and dependency direction |
| --- | --- |
| `factory/cli.ts`, `server.ts` | Factory process/client entry and composition of registry, line reader, application and HTTP handler |
| `factory/application/service.ts`, `application/ports.ts` | Logical hierarchy and scoped aggregation through registry/line-reader ports |
| `factory/application/overview.ts` | Descendant scope and partial-rollup policy; one unavailable line does not erase reachable evidence |
| `factory/infrastructure/registry.ts` | Factory-owned SQLite hierarchy and stable line registrations; no task database access |
| `factory/infrastructure/poller.ts`, `factory/http.ts` | Bounded authenticated line observation and Factory HTTP adaptation |
| `orchestrator/cli.ts` | Process entry point; parses commands and selects server startup or HTTP client/import operations |
| `orchestrator/server.ts` | Server composition root: constructs SQLite Store, application and HTTP handler; owns listener/reaper shutdown |
| `orchestrator/http.ts` | Routes, role-token authorization, request parsing and HTTP presentation; invokes application operations |
| `orchestrator/application.ts` | Commands/queries and worker-bound operations through `OrchestratorRepository`; no Node HTTP or SQLite imports |
| `orchestrator/persistence/store.ts` | Transactional SQLite implementation of that port; persists tasks, attempts, snapshots and events |
| `orchestrator/persistence/schema.ts` | Versioned SQLite schema and atomic migrations |
| `orchestrator/context/*` | Exact-commit resolution, bounded admission and operator-owned context binding; committed source remains untrusted data |
| `orchestrator/policies.ts` | Scheduling eligibility, lease ownership and snapshot-assignment checks |
| `orchestrator/intake/importer.ts` | CLI composition of local Git reads and the HTTP task gateway |
| `orchestrator/intake/iteration.ts` | Committed-feature collection and import/revision policy through `IterationSource`/`IterationTaskGateway` ports |
| `worker/cli.ts` | Parses runtime/status commands, loads configuration and supplies process cancellation |
| `worker/runner.ts` | Worker composition/lifecycle: concrete HTTP gateway, selected mock/Codex adapter, journal, identity, status service and scheduler slots |
| `worker/application/*` | Attempt execution, lease renewal, reporting and ports; no URL/bearer-token or SQLite ownership |
| `worker/infrastructure/*` | HTTP operation mapping, pinned-context verification, mock/Codex adapters, review artifacts and persisted registration identity |
| `worker/infrastructure/journal/{snapshots,files,retention}.ts` | Measurement capture, immutable journal, serialized upload and durable local file operations |
| `worker/status/server.ts`, `status/view.ts` | Read-only status HTTP server and HTML rendering respectively |
| `shared/domain.ts`, `context.ts`, `validation.ts`, `snapshots.ts` | Domain data and pure validation of input/evidence |
| `shared/protocol.ts`, `factory.ts` | Typed request/response DTOs, Factory records and overview validation |
| `shared/wiki.ts` | Pure vault-reference syntax parser; no repository resolution |
| `shared/mcp/*` | Stdio tool catalog/transport mapped to one configured HTTP service, read-only by default |
| `shared/errors.ts` | Semantic application errors, independent of HTTP status codes |
| `shared/http/*`, `cli.ts`, `html.ts` | Explicit transport, process-input and escaping adapters |

`shared/contracts.ts` and `shared/io.ts` remain compatibility facades. New code
should import the specific module it consumes; the facades are not a place to
add cross-application behavior. Semantic errors are mapped to HTTP or CLI output
at adapter boundaries. The SQLite implementation no longer needs HTTP errors.

The worker application takes an execution adapter, operational client, journal,
state callbacks and clock through its ports. This lets tests exercise terminal
reporting and cancellation without starting HTTP or a real coding agent. The
server application similarly depends on its repository port, while the
composition root chooses SQLite. Shared code never imports either application.

This is a concrete dependency improvement, not a claim that every domain rule
has a separate object model. The Store still combines transactional persistence
with several state-transition decisions. The importer composes Git and HTTP
adapters; its collection/revision policy lives separately in `iteration.ts`. `request<T>` provides a TypeScript expectation; its generic
does **not** runtime-validate an arbitrary server response against that DTO.
The worker HTTP adapter separately checks registration/assignment shapes and
verifies that heartbeat responses still identify the same attempt. Other
boundary checks remain necessary when adding external services or plugins.

## Ownership across the client/server boundary

The browser owns navigation, draft form values, filters, focus and last-rendered
responses. It must obtain accepted task state from the API. The CLI is another
API client; changing its local JSON after submission cannot change persisted
work. The worker owns physical execution and evidence, but the server decides
whether its assignment is still valid and whether a transition is allowed.

A successful HTTP response acknowledges one specific operation. Snapshot receipt
is not task completion; mock completion is not human acceptance; a target feature
PR merge is not iteration release. Stable identity links these facts without
collapsing them into one status or rewriting historical evidence.

The server's clock governs lease acceptance. Worker-side expiry timers are
conservative local cancellation guards and depend on usable clock alignment;
they do not override server lease checks. Monotonic attempt duration and server
snapshot sequence are independent from cross-host wall-clock timestamps. Full
clock-offset negotiation is not implemented in this starter.

## SQLite deployment

One orchestrator process opens the SQLite file on a local persistent volume.
WAL, foreign keys, a busy timeout and short `BEGIN IMMEDIATE` transactions protect
state changes. Schema migrations are atomic and reject newer unsupported schema
versions. A background sweep reconciles expired leases without waiting for new
claims; the attempt ceiling is pinned when work is assigned.
Tasks, attempts, snapshots and events are persisted together as
needed. Workers never mount the DB or execute SQL. Scale workers first; multiple
orchestrator replicas and network-filesystem SQLite are outside iteration one.

The starter is small and uses synchronous `node:sqlite`. Store work must stay
bounded; large portfolio analytics should eventually move to rollups/background
queries. Raw snapshots have an ascending sequence cursor and can be exported to
an analysis tool. Unknown values must remain null through every aggregation.

## Publication, fencing and snapshots

In the target integration, the worker initiates PR actions and a server-side
publisher holds Git write
credentials. It validates the live lease and serializes publication by task
revision. This prevents an old worker with a stale lease from pushing through
its own long-lived Git credential. The target publisher stages only the declared
code/artifact bundle, creates or updates the stable feature branch and correlates
its PR before retrying an interrupted publication. External Git operations require
an outbox plus reconciliation; they cannot share an SQLite transaction.

The before/after snapshot files are part of the feature PR, not only attached to
the orchestrator. Late telemetry is still accepted as historical evidence for an
authenticated old attempt, but never authorizes publication or task completion.
Failed/interrupted attempts retain evidence even when their PR stays draft.

A final telemetry commit cannot contain its own final commit hash. Snapshots
record the tested code commit/context. The orchestrator records final publication
commit, PR URL, CI and review events as separate immutable associations. If tests
ran before a telemetry-only commit, final-head CI still gates human handoff.

## Worker policy

Effective policy combines factory invariants, project configuration and worker
preferences. User prompts cannot disable lease checks, quality gates, snapshot
capture or human review. Configuration is validated and hashed; each attempt
records that hash, prompt hash, skill/policy versions and adapter version.

In the starter, settings are immutable for an identity. Restarting with changed
settings requires a new state directory after the old worker is stopped. Future
hot reload must drain the worker and version changes for future assignments only.
The configured attempt ceiling prevents an unavailable provider or impossible
check from causing endless automatic rework.

Machine slots, profile sessions and subscription quota are different constraints.
The starter enforces machine/profile slots, not real subscription limits. It
records unavailable provider/cost fields honestly. Only the narrow native Linux
Codex adapter is implemented for live execution. Claude and further adapters,
mixed live profiles and shared quota enforcement remain future work.

## Obsidian context

An intake can now contain only `project` and `requirementRef` (one wikilink).
Default unbound mock intake derives a label and preserves an unresolved reference.
Operator-bound intake resolves a ready note at an exact commit and persists an
immutable manifest. Workers verify supplied manifests before execution; the
reference alone remains insufficient proof of readiness. Explicit pinned
iteration imports validate their source against that same server binding.

The target context integration supplies the committed vault: notes, Properties, headings, blocks,
aliases, tags, links/backlinks, embedded notes, attachments and Canvas files.
The factory indexes content by commit rather than relying on a user's running
Obsidian UI or local cache. Each format needs an appropriate reader. Full context
availability does not mean blindly concatenating every file into a model prompt.

Only designated `factory_*` properties control import. A note's text, embed or
attachment does not have authority to change execution policy. Secrets, personal
workspace settings and uncommitted notes must not enter telemetry artifacts.

The implemented resolver follows explicit whole-Markdown `factory_context`
dependencies, preserves committed bytes and hashes a versioned manifest.
Canvas, attachments, selectors and the full Obsidian context model remain outside
this supported subset. See [pinned context](../reference/pinned-context.md) and
[pinned iteration import](../how-to/pinned-iteration-import.md). The concept prototype
remains separate from the runtime.

## Implemented and remaining

| Implemented | Still required for live delivery |
| --- | --- |
| Repo-ready importer, server-pinned Markdown context and worker verification | Full Obsidian artifacts, verified remote identity and explicit revisions |
| SQLite, registration, idempotency, slots, leases; viewer/operator/admin tokens | Broader identity integration, per-project enrollment grants and shared quota groups |
| Mock worker and journal; opt-in single-slot native Linux Codex patch adapter | Additional live providers, mixed live profiles and project-specific tool/skill policy |
| Verified local review artifacts and telemetry API | Lease-checked Git push, early draft PR and review requests |
| Snapshot dashboard, worker detail, readiness and operational alerts | Git webhook verification, independent project checks and review/rework loop |
| Native/Docker launchers, VM profile, qualification gates and stopped-state backup/restore | Environment-specific deployment qualification and high-availability design |

The native, Docker and VM gates validate simulated task journeys. Their existence
does not establish that a particular release passed: inspect its completed
[qualification checks](../reference/releases.md#candidate-qualification-gates).
The authenticated Codex qualification attempt in the managed environment received
HTTP 403; provider-account and endpoint qualification remains deployment-specific.

## Source references

- SQLite WAL and single-writer constraints: https://www.sqlite.org/wal.html
- Docker Compose services/scaling: https://docs.docker.com/reference/compose-file/services/
- Dynamic port lookup: https://docs.docker.com/reference/cli/docker/compose/port/
- Claude Code headless CLI: https://code.claude.com/docs/en/headless
- Claude Code authentication: https://code.claude.com/docs/en/authentication
- Codex programmatic CLI: https://learn.chatgpt.com/docs/non-interactive-mode
- Obsidian links: https://obsidian.md/help/links

Provider-specific details must be rechecked when implementing adapters. Native
subscription CLI login is the intended baseline; do not silently substitute an
API key, different billing mode or a different provider.
