# Unified Werk views and worker gate qualification

Date: 2026-10-14. This report covers the final working-tree iteration on
`codex/werk-journey-polish`; it is candidate qualification, not a published release.

## Result

Factory, production-line, orchestrator, worker and concept task boards use one
[TaskKanban component](../../src/shared/webview/components/TaskKanban.vue).
It owns grouping, composite source/task identity, visible-page counts, unknown
status retention, gate badges and mobile column navigation. Each host retains
its authenticated data adapter and lawful actions. The Factory uses bounded,
source-labelled pages and explicit partial/error states rather than claiming a
global task total. Large valid acceptance-criteria payloads are fetched in pages
of at most ten tasks before the server strips private bodies and lease data.

Every product webview now uses Vue and Nuxt UI, with shared layouts, access,
status, map, interaction and tour components. Factory/orchestrator/worker remain
independently runnable. Public guide, concept simulation and diagnostic exports
are self-contained HTML. The release needs Node 24 or Docker, without npm or a
source checkout. See the [architecture contract](../reference/webview-architecture.md).

The worker owns durable request state, frozen JSON Ready/Done policy, guarded
commands, deterministic evaluations, advisory questions/issues/gaps, text
candidates, explicit human acceptance and bounded LLM rework. Reviewer usage is
recorded separately from primary execution. Unknown facts fail closed. Known
model results survive projection failures and restart without automatic replay.
Remote readiness holds, upstream successors and retained-result Done releases
preserve lease ownership and original snapshots. Patch evidence is reverified
before a deferred release; a fresh request-state check fences cancellation while
that asynchronous verification runs.

Feature files retain established execution statuses while recording gate phase
separately. Held gates remain visible. Genuine failed-attempt retry rechecks the
frozen policy; held or known-completed output cannot be retried through that path.
A stale file projection after an admission/save failure now rejects a repeated
retry before another model invocation. A saved request command receipt separately
reports whether the current generation was admitted; replay never dispatches
newer work. See the [request contract](../reference/request-gates.md),
[operator workflow](../how-to/rework-worker-requests.md) and
[independent review](worker-request-gates-review.md).

## Screenshot-driven corrections

Actual browser journeys drove corrections to Factory rename scope, empty-select
resets, narrow navigation and map layout, concept per-line draft isolation,
shared tour focus/race behavior, request-panel table containment, long-ID wrapping and the New task selector
grid at 320 pixels, plus keyboard focus restoration after Concept intake
replaces the drawer opener. The gate workflow checks policy draft preservation, lost acknowledgement
retries, readiness blocking, reviewer findings, human resolution, explicit model
rework, candidate acceptance, completion attestation and lock/privacy cleanup.
Simulation and protocol fixtures are labelled; they are not live provider proof.

The [interactive sitemap](werk-unified-views.html) contains current route/panel
captures and evidence provenance. The earlier [detailed worker atlas](worker-view-atlas.html)
is historical evidence from the preceding iteration, not a claim that its old
screenshots show the final UI.

## Validation

- Full all-application build and suite: **839 passed, 1 platform-specific skip, zero failures** (840 tests). TypeScript and all Vue entries passed typecheck.
- The gate CSS-only follow-up passed **23 focused asset/controller checks** and the actual five-state desktop/mobile gate journey. The final ignore-rule follow-up passed all **3 installation tests**, including repeat initialization and native feature execution.
- All four extracted native/Docker runtime and project-worker journeys passed. Additional native/Docker gate CLI workflows and the copied CLI management lifecycle passed without npm or source overlays.
- The gate browser journey used real HTTP and journals with explicitly injected no-network model fixtures: one primary invocation, three advisory invocations, ten inspected images, zero page errors or document overflow.
- Dependency audit: zero reported vulnerabilities. Generated workflows are in sync; strict vault validation has zero errors; whitespace checks passed.

The final verified archive contains **1,504 manifest files**. Its tar.gz SHA-256 is
`938ff1459b2e4212efb4a4f4e34bafe4da153e53ef27eaad0d13ce4d0aa01d57`.
The initial smoke-tested archive was `a13695233bcb7a715dc024e3130b986d8508b9d004e4cc34b6ede0d66b1f1401`.
Manifest comparison proves the intervening changes are worker browser assets
for the scoped mobile correction, four copies of the installer ignore helper,
its operator guidance, and Concept HTML for drawer focus restoration. Backend
execution files are byte-identical. The final package additionally fixes
the New task form grid at 320 pixels with scoped CSS; it passed typecheck and
23 focused checks again. The gallery identifies the candidate used for each
capture; the gate component is unchanged from the corrected gate journey. The
Concept focus follow-up passed typecheck and 43 focused concept/asset tests.

[Machine-readable qualification and comparison](../evidence/archive/werk-unified-worker-validation.json)
records the exact archive identities and changed paths. Source commit is null
because these qualification archives were built before the final commit.


## Practical limits

No paid model call, subscription-provider authentication journey or hours-long
soak was performed. Worker resources describe the Node process, not provider
subprocesses or the whole host. Context continuation is worker-owned replay, not
an unsupported claim of native provider session recovery. Consumption remains
provider-reported; unknown values stay null and subscription balances are not
inferred. Request Done reflects configured observed facts, not automatic test,
apply, publication or merge approval.

The browser environment blocks `file://` navigation. Self-contained guide/status
exports were exercised over isolated localhost with no external asset/API reads;
actual file-protocol opening is unverified. Desktop Chromium mobile emulation does
not establish physical-device or screen-reader behavior. No tag, release or merge
was created during this qualification.
