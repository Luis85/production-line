# Review and validation history

## Pass 5 — Factory visualization and development handoff

Completed 2026-10-12. The final TypeScript check, all three independent builds
and **142 test-runner cases passed**, with no failures or skipped cases.
The standalone concept is v1.9. All six handoff documents have valid local
links. Each complete CLI distribution was copied outside the source tree and
its `--help` entry ran successfully with Node, without sibling source access.

The concept now visualizes nested Factory boundaries and isolated production
lines in a selectable production map. Each line shows exactly one orchestrator,
its workers/profile capacity, project repository and directed assignment,
publication and PR-feedback paths. Native HTML selectors complement the SVG;
selection is read-only, with explicit Intake, 3D and review drill-down actions.
The original single-line 3D visualization and default Intake remain available.

The operational Factory topology groups lines by their actual owner and shows
one orchestrator plus an aggregate worker pool per line. Topology/table switching
preserves scope, observations and drafts without another request. Unknown,
stale and partial data remain distinguishable; individual worker/repository
identities are not fabricated from aggregate API data.

Seven added tests cover diagram nesting (including empty children), exact line
identity, selection without task mutation, capacity/profile distinctions,
escaped labels and keyboard alternatives, unknown operational measurements,
scoped drill-down, and representation switching without state loss.
The bounded final layout scan reports no findings in the two changed surfaces.
Browser rendering was unavailable, so this does not certify responsive visual
quality, contrast or assistive-technology behavior.

`HANDOFF.md` is the development entry. The handoff package includes 24 traceable
requirements, actual interface and migration contracts, dependency-ordered
implementation slices, live acceptance gates, visualization behavior and a
fresh coding-agent prompt. It distinguishes implemented mock behavior from
planned live provider/Git/PR execution and the unverified Docker/Docker Agent
runtime. No new live execution capability is implied by these documents.

## Pass 4 — integrated journey, layout and service boundaries

Completed 2026-10-12 through six parallel reviews. The final TypeScript check,
all three independent builds and **135 test-runner cases passed**, with no
failures, skipped cases or cancellations. The standalone concept is v1.8.

### Journey and layout

Factory places each line's Intake action next to its identity, preserves
keyboard focus during refresh, and distinguishes fresh cached data from stale
observations. Field errors retain drafts, identify the invalid control and
move focus to the recovery action. Long hierarchy names wrap safely.

The orchestrator moves focus from connection into Intake. Opening a saved task
clears filters that could hide it and leads directly to its events and scoped
snapshots. Evidence supports refresh, close and return-to-task actions; changing
filters removes only evidence outside the selected scope. Tables and charts
have labelled keyboard scroll regions. Detail actions remain outside long JSON
scroll areas, and the chart retains a readable drawing width.

The concept separates portfolio management from line execution controls and
keeps unsent drafts per production line. An unresolved requirement can be
corrected on the same unstarted task without losing its identity/history;
unknown notes stay blocked. Empty worker assignments explain why no candidate
is eligible. The existing visual identity and 4/8/12/16/24/32/48px rhythm remain;
changes focus on grouping, wrapping, recovery and the next useful action.

### Clean architecture and client–server corrections

| Finding | Implemented correction |
| --- | --- |
| A rejected line reader could discard healthy portfolio observations. | Factory isolates the failure to that line and reports partial known totals. Pure descendant/rollup policy is separated from application coordination. |
| Missing deployment credentials prevented unrelated edits to a registered line. | Existing names, hierarchy placement and browser URLs remain editable; new/changed credential references still require configuration. |
| Workers trusted any HTTP 200 as a successful snapshot or completion. | The HTTP boundary validates snapshot identity/digest and terminal ownership before accepting success; invalid acknowledgments retain pending evidence. |
| Task completion could conceal a polling outage. | Worker connectivity is tracked separately from slot activity, preserving disconnected status until synchronization succeeds. |
| Development children inherited unrelated administration tokens. | Launchers strip inherited Werk token variables and inject only the credentials each child role needs. |
| Explicit null MCP params/arguments were treated as empty objects. | Protocol validation rejects null while retaining support for omitted optional objects. |

Focused regressions cover these behaviors, line draft isolation, unresolved
requirement correction, focus/recovery, evidence navigation and malformed saved
topology. API routes, SQLite ownership and human review/merge semantics remain
unchanged. No cross-application implementation imports were introduced.

### Verification limits

The final five-process launcher smoke passed after the credential and worker
acknowledgment changes: both isolated vault tasks reached `simulated`, both lines
returned after restart, identities/credentials were reused and shutdown was clean.

The bounded final source-layout scan reports only three inherited `.note`
padding warnings, explained by their explicit logical padding of 24px/16px.
No Factory, concept or worker layout warnings remain. This is source evidence,
not rendered visual acceptance. Browser/device interaction, Docker execution and
Docker Agent's actual loader/provider execution remain unverified. The MCP
bridges were tested as real subprocesses against real HTTP services; this does
not establish live coding or Git/PR delivery integration.

## Pass 3 — factories, vault intake and Docker Agent interfaces

Completed 2026-10-12. Factory is an independent third application with its own
CLI, HTTP API, SQLite registry and webview. It manages child factories and line
registrations, while each line's orchestrator retains its taskboard and worker
ownership. Cycle rejection, endpoint uniqueness, bounded polling and explicit
partial/unknown rollups protect the hierarchy and portfolio view. This first
version uses one Factory registry for its complete hierarchy.

Intake now accepts a single vault Wikilink plus project selection. HTTP, CLI and
webview preserve the canonical reference without requiring copied criteria.
The runtime records it unresolved; the concept resolves only its sample notes
and blocks unknown references. Real execution must resolve and pin repository
context before implementation.

Docker Agent integration includes separate Claude/Codex CLI harness YAMLs and
native local/API operations YAMLs. Factory and orchestrator provide stdio MCP
bridges over their existing HTTP interfaces. Bridges default to read-only;
explicit write enablement is required for registry changes or task submission.
No bridge exposes worker completion, lease overrides, arbitrary HTTP requests
or shell execution. Task submission retains durable idempotency; Factory
registry mutations now use atomic durable receipts when a key is supplied; see
[Factory idempotency](../reference/factory-idempotency.md) and the [pass 4 review](pass4-review.md).

A real local launcher smoke started five processes: Factory, two independent
orchestrators and one worker on each line. Both vault-only tasks reached
`simulated`, each line excluded the other's task, and a clean restart preserved
credentials, worker identities and line registrations. Both line summaries
became available again. Three independent CLI distributions are included.

The concept, Factory and Intake UI checks cover source markup and scripted
interaction behavior. A bounded layout scan found no Factory/concept warnings;
three runtime note warnings are accounted for by explicit logical padding.
Browser rendering, Docker, Docker Agent's configuration loader, native model
calls and subscription coding CLIs were unavailable for execution. The four
Docker Agent YAMLs were parsed and checked for harness/toolset separation.
Live coding, snapshot publication to Git and PR/review synchronization remain
future adapter work; the new interoperability layer does not complete that
pipeline. See [Docker Agent integration](../how-to/docker-agent.md) for local acceptance
commands and authentication boundaries.

## Pass 2 — coherent layout, journey and architecture

Completed 2026-10-12 with six parallel workstreams. The integrated TypeScript
check and **all 74 test-runner cases passed**, with no failures or skipped tests.
Both independent CLI distributions were rebuilt from the final sources.

### Layout and journey

The concept, orchestrator and worker views now share the 4/8/12/16/24/32/48px
spacing scale and semantic page, panel, section, field and inline roles. Desktop
page padding is 32px, panel padding 24px; narrow layouts use 16px insets. Standard
controls share a 44px minimum height. Repeated stylesheet overrides were
consolidated, and runtime inline spacing styles were removed.

Weekly iteration import leads the concept Intake; individual feature entry is
a secondary disclosure. Import confirmation provides a persistent route to the
correct project board, and review navigation clears conflicting filters while
preserving unsent drafts. The runtime explains connect → intake → execution →
measurements, collapses authentication controls after connecting and links task
details directly to scoped snapshots. Its target PR lifecycle remains explicitly
separate from the implemented mock workflow.

### Implemented architecture changes

| Area | Responsibility and dependency change |
| --- | --- |
| Orchestrator | `server.ts` composes the process; `http.ts` handles transport/authentication; `application.ts` operates through a repository port. SQLite schema and reusable scheduling/provenance policies are separated from request handling. |
| Iteration intake | Collection and submission use cases are separated from Git and HTTP adapters, allowing dry-run and concurrent-import behavior to be tested without invoking external tools. |
| Worker | The runner composes an injectable gateway and execution adapter. Attempt execution, leases and reporting depend on application ports; the HTTP gateway translates transport failures into retry decisions. |
| Worker status | HTTP lifecycle and HTML rendering are separated; live and exported status use the same renderer. |
| Shared | Pure domain types, validation and semantic errors are separated from CLI/HTTP adapters. Protocol DTOs describe exchanges. The generic HTTP client parses JSON; callers still own runtime shape validation. |

HTTP routes, CLI commands, database schema 3 and snapshot schema 1 are retained.
An internal import changes: `ApiError` belongs to `shared/http/errors.ts`;
domain validation now reports semantic error codes instead of HTTP statuses.
Application packages do not import each other's implementation. Dependency
tests include imports, re-exports, dynamic imports and import types.

This is a focused separation of responsibilities, not a claim of complete domain
isolation. The SQLite Store still combines transactions with some task-state
decisions. Compatibility facades retain existing internal entry points where
useful; new code should import the specific module it needs.

### Evidence and verification limits

The 23 additional cases cover dependency direction and error mapping,
authenticated identity binding, rejected cursor inputs, HTTP error redaction,
side-effect-free iteration collection, concurrent imports, substituted worker
ports, terminal replay, malformed assignments and connected user journeys.
The previous three-process HTTP/SQLite fleet test and slow-reporting lease test
still pass. UI markup and JavaScript behavior were checked; no rendered browser
or device session was available.

A bounded mechanical layout scan found no remaining table-wrapper warnings.
Four `.note` inset warnings are explained by the detector's handling of logical
CSS properties: these elements explicitly use `padding-block` of 24px or 16px.
The source evidence is recorded here rather than adding redundant CSS overrides.
This scan does not establish visual quality, keyboard behavior or accessibility
conformance. Browser, Docker and Windows execution remain unverified.

See [the architecture decision](../explanation/adr-001-client-server-boundaries.md) and
[the UI journey/layout contract](../explanation/ui-journey.md) for maintenance guidance.
Live provider invocation, Git pushes and PR/review synchronization remain future
integration work; no mock outcome is represented as delivered software.

## Pass 1 — runtime hardening

Reviewed 2026-10-12. Six parallel reviews covered the orchestrator, worker,
shared contracts, runtime webviews, concept prototype and developer operations.
The changes were integrated and checked together on Node.js 24.19.0.

## Most consequential corrections

| Finding | Result after this pass |
| --- | --- |
| Expired work could stay running until another worker claimed a task. | Background and read-time reconciliation release expired leases; assignment-time retry ceilings are retained. |
| Workers could stop heartbeats before slow telemetry or completion requests finished. | Lease renewal covers reporting, occupied slots remain visible, and persisted terminal snapshots prevent re-executing a completed attempt after a reporting outage. |
| Database migration could partially commit. | Schema 3 migration is transactional and tested for rollback and reopen. Historical provenance identifiers are preserved. |
| Ambiguous API outcomes could duplicate work or break retries. | Intake retains its idempotency key after a network failure; abandonment replay acknowledges the original attempt without mutating its successor. |
| Snapshot payload validation trusted incomplete or inconsistent data. | Nested contracts, units, finite values, source provenance, chronology and artifact paths are validated. Unknown mock cost, usage and quality remain unavailable. |
| Dashboards could show stale responses or only the oldest telemetry. | Request sequencing protects navigation and details; latest-first pagination shows the newest data with explicit window limits and freshness. |
| Concept failure paths lost after-snapshots and concurrent tasks were hidden. | Failed attempts retain evidence; capacity and inspector views include all active slots; charts derive from the actual simulated snapshot history. |
| Import project selection and dry-run inputs could be misleading. | Concept Intake has explicit project selection; runtime dry-run accepts only true/false and rejects typos before Git or network activity. |
| Development builds and fleet setup had stale-output and operational traps. | Independent clean distributions, strict port/argument checks, credential reuse, state locks, ordered shutdown and Bash/PowerShell instructions are included. |

## Interface and user experience changes

- Intake remains the first active page. Search, status filters, focused task
  details, explicit loading/empty/error states and pausable live updates improve
  the runtime taskboard.
- Portfolio metrics filter by project, worker, iteration, time and outcome.
  The dashboard loads at most the latest 10,000 snapshots and labels truncation.
  Scatter-plot sampling does not change percentile calculations. Pair
  completeness is scoped to the selected window.
- Worker HTML status separates active attempts, configured profiles, process
  counters, contact freshness and the latest recorded error. Exported HTML is
  self-contained and does not poll an endpoint.
- `GET /v1/snapshots` and `snapshots list` support descending order with `before`;
  existing ascending `after` cursors remain available. Responses add `hasMore`.
- Malformed or unknown request/configuration fields now return input errors.
  Clients must use the actual server URL because credential-bearing requests
  no longer follow redirects. JSON responses are bounded to 8 MiB.
- The concept demo keeps its own browser state. Its illustrative PR/review flow
  remains distinct from the server's persisted mock taskboard.

## Verification

Run from the project root:

```text
npm run typecheck
npm test
```

Both passed after integration. The Node test runner reports **51 passing test
cases**, with no failures or skipped cases; one case also contains the existing
comprehensive prototype assertions.

Coverage includes transactional migration rollback, idle lease expiry, stale
attempt fencing, snapshot recovery and late telemetry, unsafe paths/symlinks,
strict contracts, reporting retry and replay, API/CLI validation, importer
deduplication, UI request races and standalone status export. The fleet test
starts three real worker child processes against the real HTTP/SQLite server,
completes nine mock tasks and checks their eighteen snapshots. A slow-reporting
test verifies that a 450 ms lease survives a 750 ms upload and transient
completion failures without repeating execution. Developer-operation tests
exercise clean relocatable builds and fleet lifecycle using controlled children.

## Practical limits

This release remains an executable mock foundation. It does not invoke
Claude/Codex, push Git changes, create actual PRs, ingest review webhooks or
complete a real implementation workflow. Local repository snapshot files are
written when configured; publishing them to a PR remains future work.

Dockerfiles and Compose are provided and reviewed, but Docker execution was
unavailable here. The permitted browser automation capability was unavailable,
so responsive layout, pointer interaction and assistive-technology behavior
still require browser/device acceptance checks. The UI tests exercise
JavaScript behavior and generated markup, not rendered layout.

SQLite supports the intended single orchestrator. Multi-server operation,
production access control, real subscription quotas and provider credentials
remain outside this iteration. See [architecture](../explanation/architecture.md) for the live
delivery integration sequence and [operations](../how-to/operations.md) before operating
a persistent fleet.
