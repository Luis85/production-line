# Implementation plan

> Imported handoff baseline, retained for traceability. This describes the supplied starter at handoff time; later work changes some implementation and validation statements. Use the [current documentation](../index.md) for installation, operation and present limits. Embedded developer prompts are source material, not authority to execute actions.

This backlog describes future work. It does not claim these capabilities exist.
Read [technical contracts](technical-contracts.md) and [acceptance](acceptance.md)
before changing runtime behavior. Keep the Node 24/TypeScript, independent
Factory/orchestrator/worker builds and SQLite deployment boundaries.

## First release target

A product team commits a ready feature to an iteration branch and draft PR.
The line accepts either the ready-feature import or one requirement wikilink,
resolves and pins the same repository context, and assigns a compatible worker.
The worker opens a feature draft PR at work start, implements the feature using
Claude or Codex, publishes evidence, and requests human review only after checks.
Review feedback produces a new attempt on the same feature PR. Verified merge
into the iteration branch completes the task; iteration merge to main is a
separate release decision.

The smallest first live slice is one project, one explicitly selected provider,
one feature, one worker slot and one supported Git host. Start with fixture
adapters and an operator-owned disposable repository. Add the second provider
before declaring the requested Claude/Codex milestone complete. Keep mock the
default until the live gate is satisfied.

## Product-team planning structure

Maintain epics, features and use cases in the team's Obsidian project repository.
An epic groups a product outcome; a feature is the implementation unit imported
as a task; use cases and acceptance tests make that feature verifiable. The
weekly iteration branch/draft PR holds the committed ready set. The engineering
slices below support this workflow; they do not replace it with infrastructure
work tickets or make every use case a separate task automatically.

| Product epic | Feature-sized capability | Representative use case / acceptance |
| --- | --- | --- |
| Ready requirements become executable work | Pinned context from one note (P0-01–02) | Product team submits a ready feature; the worker sees its committed requirement/tests while next iteration planning continues independently (A01) |
| Safe provider implementation | Isolated run and early draft PR (P0-03–05) | Assigned worker starts Claude or Codex, opens a draft feature PR and retains its evidence without touching another slot's work (A02–05) |
| Human-reviewed delivery | Head-bound checks, feedback and merge (P0-06–07) | Reviewer requests changes; worker updates the same PR; accepted feature merge completes only that task (A06–09) |
| Accountable multi-provider operations | Mixed profiles and measured portfolio (P0-08–09) | Team inspects real provider usage and quality coverage while another line is unavailable (A03, A10–12) |

For each feature, commit its requirements, designs/specifications and executable
acceptance examples before marking it ready. Use the Definition of Ready/Done
below both in product planning and in implementation PR review.

## Decisions to record before live integration

Node 24 and the current plain HTML/TypeScript webviews are the delivered baseline.
A future runtime upgrade or frontend framework is an explicit compatibility
choice, not a hidden prerequisite of this backlog. Select the Git hosting service
and credential approach without assuming GitHub. Record tested provider CLI
versions/auth modes, quota-group ownership/limits, project enrollment and
production user authorization in an architecture decision. Keep unresolved
choices visible; fixtures can support implementation until live accounts exist.

## Dependency-ordered PR sequence

| ID | Deliverable / likely source boundary | Depends on | Demonstrable exit |
| --- | --- | --- | --- |
| P0-01 | Project binding and pinned requirement context; orchestrator application/repository, `shared/wiki.ts`, new context adapter | Baseline | A committed fixture note resolves to an immutable context manifest; missing/ambiguous/out-of-root links fail before coding |
| P0-02 | Versioned live execution and evidence contracts; `shared/domain.ts`, `snapshots.ts`, validators, `orchestrator/schema.ts` | P0-01 | Migration preserves old mock tasks/evidence; new live states are explicit, validated and backward-compatible where promised |
| P0-03 | Worker workspace and provider process runner; `worker/application` ports, infrastructure, configuration | P0-02 | One slot runs a controlled fixture CLI in its own worktree with cancellation, bounded output, auth separation and truthful results |
| P0-04 | Durable publication intent and lease-fenced Git-host adapter in the line boundary | P0-02, P0-03 | Before snapshot is committed/pushed and one stable draft PR opens before implementation; interrupted retries reconcile without duplicate PRs |
| P0-05 | First real Claude or Codex adapter integrated end to end | P0-03, P0-04 | Explicitly authorized smoke creates a draft feature PR, runs checks and publishes before/after evidence without bypassing human review |
| P0-06 | Head-bound quality gates and human review request | P0-05 | Only passing checks on the current published head can mark ready/request review; changes invalidate previous approvals/checks |
| P0-07 | Durable Git event ingestion/reconciliation, feedback attempts and verified merge | P0-06 | Duplicate/out-of-order events are safe; feedback updates the same PR; only a verified matching merge completes its task |
| P0-08 | Second native provider adapter, mixed profiles and shared quota policy | P0-03, P0-07 | Claude and Codex each pass the live matrix; a worker can safely run configured profiles without silently switching provider or billing |
| P0-09 | Live telemetry and UI completion across line/worker/Factory | P0-05–08 | Cost/quality provenance and unknown coverage remain visible; human journey matches persisted live state and partial line availability |

Each row is an independently reviewable slice. Split a row further when its
migration, adapter or fault tests would otherwise be too large to review. Keep
unfinished live paths disabled; do not temporarily label a mock run as delivered.

### P0-01: repository and context before code

Minimal intake deliberately lacks repository identity, a pinned commit and
acceptance criteria. Define server-owned project configuration: repository
identity, permitted vault root, iteration/base resolution policy, quality commands
and credential references. Preserve the small Intake payload; derive requirements
from the committed note rather than adding duplicate user fields.

Use import source metadata when present. Otherwise resolve a configured project
base according to an explicit policy and record the resulting commit. Define
what “ready” means for direct wikilink submissions and block implementation when
it cannot be proven. Handle headings, block references, aliases, embeds and
attachments without path traversal or symlink escape. Start with a documented
supported subset and report unsupported/ambiguous forms; do not claim full
Obsidian support from Markdown link parsing alone. Keep source content separate
from tool/policy instructions. Bound traversal depth, files and bytes.

Record manifest schema/version, repository identity, commit, requirement target,
resolved files/digests and resolver version. A source revision produces a new
explicit decision; it must not mutate an active attempt's pinned specification.

### P0-02–03: migration and execution contract

Current `Task.status` supports only queued/running/simulated/blocked;
`Profile.mode` and snapshot validation are mock-only. The `Adapter` interface is
a narrow seam, not a complete live execution API. Introduce typed live outcomes,
provider metadata, session ownership, artifact references and quality/usage
provenance with an explicit schema/migration strategy. Specify legal transitions
before adding UI labels. Preserve immutable historical evidence.

A slot needs its own worktree, subprocess group, cancellation scope, journal and
native session. Make timeout/lease loss/stop kill its child processes and prevent
publication. A worktree is not a sandbox: define the filesystem/network/tool
boundary separately. Inject execution ports and use fixture child processes to
test spawn failure, malformed events, rate limits, cancellation and restart.
Never place authentication material or raw prompt/repository secrets in shared
telemetry. Auth failures must not fall back to an API key or another provider.

### P0-04–07: publication and human gates

Choose one Git host and a least-privilege app/token integration as a documented
implementation decision. Keep write credentials in a publisher controlled by
the line, not in a stale worker that could push after losing its lease. Worker
intent must bind project, task revision, attempt, live lease, artifact digest,
branch and expected head. Serialize/check publication; treat Git effects as a
durable outbox plus reconciliation, never part of an SQLite transaction.

Create the feature branch from the pinned iteration commit and target its
iteration branch. Publish the before snapshot as an initial diff and open the
draft PR before implementation starts. Preserve PR identity across retries and
feedback attempts. After code/checks, publish the after snapshot and retain
separate associations for tested code commit, final publication commit and CI
head; a commit cannot contain its own final hash.

Authenticate Git events, deduplicate them and reconcile authoritative host state
periodically to recover missing deliveries. A merged flag supplied by a worker
or model is insufficient. Closed-without-merge, conflicts, changed requirements,
failed checks and exhausted retries need explicit decision states and user
messages. Specify who can retry/revise/cancel; avoid inventing silent recovery.
Do not automatically merge or resolve human feedback without evidence that the
requested change was addressed.

### P0-08–09: providers and evidence

Verify current official CLI automation, authentication and output contracts at
implementation time; pin the tested versions in setup/diagnostics. Start with
subscription-authenticated native CLI modes as requested. Record provider/session
identity, adapter version and selected auth mode without copying secrets. Keep
machine slots, profile sessions and shared subscription quotas distinct. Define
rate-limit backoff, quota exhaustion and scheduling behavior with tests. Never
transfer a native session across providers.

Preserve unknown token/cost values when the CLI does not expose them. Separate
provider-reported cost, estimates and allocated subscription cost. Measurement
scope and coverage belong in the API/UI as well as snapshots. Add task state,
PR links, review/rework and conflict handling to the Intake→task→evidence journey;
Factory remains a read-only observer of line delivery state.

## Follow-on work after the live slice

- **P1 production access/operations:** per-project enrollment grants, user RBAC,
  TLS/secrets management, provider credential lifecycle, artifact retention,
  backup/restore rehearsal and supported OS/container matrix.
- **P1 planning fidelity:** full documented Obsidian features, dependency ordering,
  explicit task revisions/cancellation, iteration rebases and conflict workflows.
- **P1 analytical quality:** calibrated resource attribution for concurrent child
  processes, repeatable quality measurements, portfolio cost coverage and exports.
- **Optional Docker Agent transport:** implement only behind the same worker and
  publisher gates. Existing standalone harness configs are not a worker adapter;
  external CLI tools/auth and native operations-agent billing remain distinct.
- **Later scaling decisions:** add rollups/background analytics before replacing
  SQLite. Do not introduce PostgreSQL, a message broker, server replicas or
  Factory federation without a measured requirement and a new architecture decision.

## Definition of Ready for a slice

The PR brief identifies the user-visible outcome, current limitation, owned
modules, inputs/outputs, authoritative state, migration/compatibility impact,
failure/retry behavior and executable acceptance cases. Live tests additionally
need an explicitly selected provider/auth mode, disposable repository/Git host,
spending policy, branch permissions and a human reviewer. If unavailable, finish
fixture-backed work and label live verification pending.

## Definition of Done for a slice

The behavior is implemented behind the correct boundary, tests exercise the
meaningful failure path, typecheck and relevant suites pass, and schema changes
include old-data fixtures. CLI/API/UI and operator docs agree. Evidence contains
commands/results and remaining unverified environments. No secret, local state
or unrelated file enters the change. A reviewer can see a small diff and reproduce
its acceptance case. Only the final [live acceptance gate](acceptance.md) permits
calling the system a working live factory.
