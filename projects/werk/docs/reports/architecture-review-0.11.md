# Architecture, mutation testing and system documentation review

Date: 2026-10-17. Scope: Werk 0.11.0, following the released 0.10.0 baseline.
The review covers Factory, orchestrator, worker, shared contracts, browser stores,
portable distributions, release automation and the public Storybook. The goal is
less repeated implementation, explicit ownership and small modules with clear
responsibilities. Maintained source is capped at 400 code-bearing lines per file;
tests and test helpers are capped at 450. Blank and comment-only lines are excluded.

## Acceptance criteria

- Existing task identities, immutable receipts, transaction ordering, cancellation,
  retries and human review boundaries remain intact.
- Shared helpers consolidate repeated mechanics without deciding application policy.
- External response validation and public projections match their documented contracts.
- Oxlint and fallow-rs run in the normal fast check, with explicit reviewed export debt, strict new-finding detection and unbaselined architecture rules.
- Maintained JavaScript, CommonJS and TypeScript tests and supporting fixtures
  are typechecked against original application contracts. Blanket checking
  suppressions are rejected; deliberate invalid-input cases use checked expectations.
- Stryker records reproducible, explicitly scoped baselines. It stays outside
  normal development checks, and its release job reports warnings without gating publication.
- Storybook starts with useful setup paths for all supported audiences and retains
  source-derived frontend contracts, interactive states and qualified screenshots.
- Independent implementation review, browser checks, full checks and archive/CI
  qualification precede release. The exact tagged workflow establishes publication.

## Findings and decisions

| Perspective | Finding | Implemented response |
| --- | --- | --- |
| Service ownership and persistence | Seven Promise-tail queues repeated failure recovery and drain behavior across six worker classes. | A pure `SerializedOperations` helper shares FIFO scheduling and failure isolation. Each service retains revision checks, transaction boundaries and admission/cancellation policy. Drain is explicitly a snapshot, not a shutdown lock. |
| Adapters and portability | Factory, MCP and web tools bypassed the packaged owned HTTP transport; provider and shared clients repeated dispatcher/proxy selection. | One owned dispatcher helper supports the existing adapters through complete response consumption. Their authentication, deadlines, redirects, byte limits and protocol errors remain separate. No mutation or inference retry is introduced. |
| External contracts | Assignment response validation covered lease routing but allowed malformed task inputs into the worker application. | Validate the consumed task fields, exact routing identities, timestamps, context and gate evidence before admission. Preserve valid extension fields and legacy absent execution mode; report a generic safe protocol error. |
| Architectural enforcement | Factory application policy and the root orchestrator application were outside the inward-dependency guard. | Expand AST checks and negative fixtures to those boundaries and deterministic intake policy. Keep concrete composition and infrastructure separate. |
| Dependency and lint quality | Fast development checks lacked an enforced JavaScript/Vue correctness and dependency-analysis layer. | Pin Oxlint and fallow-rs; check maintained source, scripts and tests. Preserve legitimate public exports through an explicit reviewed baseline while failing new findings, unresolved dependencies and cross-service imports. Retain independent AST guards for inner-layer policy. |
| Public response ownership | Worker status summaries spread persisted policy objects, allowing internal fields to escape. | Introduce an explicit public policy projection shared by store and pagination; keep private persistence and scheduling hashes unchanged. |
| Frontend reuse | Three stores repeated JSON request construction; three settings panels repeated uncertain-save feedback. | Share wire defaults and a presentation-only recovery component. Stores still own credentials, stale-response fencing and idempotency; editor controllers still own drafts and exact retries. |
| Test quality | Tests imported compiled JavaScript without checking their original contracts, and passing assertions did not quantify behavioral sensitivity. | Typecheck all maintained tests against source, repair incomplete fixtures and obsolete private instrumentation, and use pinned Stryker on shared control flow, consumption accounting and assignment boundaries with explicit provenance and survivor reporting. |
| Module cohesion | Large workspace, task, conversation, journal, Store and UI modules mixed several concerns. | Extract commands, admission, execution, recovery, persistence mapping and frontend controllers into typed collaborators. One owner retains each transaction, mutable runtime and serialized queue; strict file-size checks prevent regrowth. |
| Release operations | A mutation tool failure or timeout could accidentally become a publication dependency. | Run an independent tag/manual advisory job with bounded execution, soft failure, retained reports and fallback infrastructure warnings. The publication dependency graph excludes it. |
| Documentation and onboarding | The public Storybook opened an advanced consumption fixture; setup guidance sat after component groups. Empty Controls UI consumed substantial space. | Lead with ordered setup/operating paths and a searchable handbook generated from canonical Markdown. Keep interactive component reference and system journeys available after the documentation entrypoints. |
| Documentation integrity | Existing Storybook source provenance did not include Markdown guidance. | Include rendered documentation inputs in the source digest and validate documentation captures separately from component coverage. Stale guide changes invalidate qualification. |

## Storybook audit and user journeys

Fresh desktop and mobile captures of the released source were taken before changes.
The audit used a local build of the public documentation; access to the hosted
Pages domain was not available from the executor. The capture showed the following
journey problems, rather than inferring them from source alone:

1. **Entry:** advanced consumption settings opened first, without a clear setup choice.
2. **System guide:** useful topology guidance existed, but was buried after runtime
   component groups and accompanied by an empty Controls panel.
3. **Mobile guide:** secondary navigation occupied much of the first viewport;
   “Return to this runtime” was misleading in a static example.

The documentation now separates getting started, local-worker setup, shared-team
intake, system operation and frontend reference. Commands retain their prerequisites
and simulation/live-provider distinctions. Maintained Markdown is rendered from its
canonical source, rather than copied into a second manual. Frontend reference keeps
component source locations, props/events, routes and fixture states visible.

Browser qualification checks navigation, search, internal links, responsive layout,
keyboard use and settings recovery. Screenshots support visual findings; they do not
establish full accessibility compliance or authenticated provider execution.

## Mutation baseline and interpretation

The original scope covers request-gate evidence, bounded HTTP response reading,
browser polling and serialized operations. The expanded scope adds worker
consumption policy and admission, its durable SQLite journal, and assignment/
acknowledgement response validation. Tests exercise real accounting recovery,
reservation and protocol boundaries. Scope changes are recorded separately from
score changes; neither baseline represents overall repository coverage. See the [mutation guide](../how-to/mutation-testing.md) and
the recorded [baseline](../../scripts/mutation/baseline.json) for counts, tool version,
source hashes and surviving mutations.

The release job emits JSON/HTML reports and a readable summary. An unavailable,
incomplete or incompatible measurement is disclosed; a stale report is not reused.
Timeouts are identified separately even though Stryker includes them as detected
mutants. Surviving mutants require review for missing assertions or equivalent
behavior, rather than automatic production-code changes or blanket suppression.

## Independent review and retained debt

Service and frontend changes were reviewed by agents other than their authors.
HTTP review exercised real streamed bodies, cancellation, size limits and disposal.
Assignment review identified and corrected a routing-identity normalization gap.
Mutation review examines real instrumentation, report provenance, process cleanup,
advisory workflow isolation and compatibility of baseline comparisons. Documentation
review checks the implemented browser journeys as well as the generated source map.

The large aggregates are now decomposed. Worker workspace commands share a single
composition context; task and conversation facades retain one runtime owner while
admission, execution and recovery live in focused modules. Request journaling and
the orchestrator Store delegate mapping and operations while keeping one database
connection and transaction owner. Browser stores use explicit controllers over
shared typed state; the concept engine separates scheduling, evidence, intake and
persistence.

Independent review compared the extracted workspace, runner, browser-store and
engine operations with their pre-extraction bodies, then checked state ownership,
shutdown sequencing, lease handling and response fencing. Runtime regressions
cover those boundaries. The size gate supports readability; it does not justify
fragmenting a transaction or compressing statements to evade the limit.

The final Fallow pass removed 20 confirmed internal exports while retaining their
local behavior and reviewed compatibility surfaces. The broader health/duplication
scan also identifies remaining branch-heavy portable CLI dispatch, worker HTTP
routing and the task-interaction template. These are explicit follow-up candidates,
not suppressed diagnostics or proof that every function is simple. Fallow's static
coverage estimates are not measured test coverage. Common settings-panel styles
are shared; portable/runtime path validation and historical receipt hashing retain
their separate distribution and compatibility constraints.

Canonical serialization is repeated with different historical handling of undefined
values. It was deliberately not unified: changing digest bytes could invalidate
persisted receipts. A future change needs versioned canonicalization and migration tests.
Fallow retains reviewed export/type-member findings where public contracts or tests of compiled distributions make source-only reachability incomplete. This baseline is debt evidence, not a claim that the repository has no unused code; see the [code-quality contract](../reference/code-quality.md).
Some browser view types still derive from service return types; migrate them behind
explicit public contracts as their ownership becomes clear.

Exact local/CI qualification and release status are recorded on the integration PR
and the [0.11.0 release](https://github.com/Luis85/production-line/releases/tag/v0.11.0).
Mock and fixture tests do not demonstrate live commercial-model execution; that
qualification remains specific to the deployed account, provider and environment.
