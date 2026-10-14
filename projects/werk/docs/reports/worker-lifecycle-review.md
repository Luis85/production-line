# Worker installation, request execution and metrics review

Date: 2026-10-14. This follows the [system journey polish](system-journey-polish.md)
and its [interactive worker atlas](worker-view-atlas.html).

The review followed a standalone worker from a downloaded package through project
installation, configurable Markdown intake, request execution and repeated-run
analysis. Six subagents covered package qualification, feature lifecycle, durable
metrics, provider accounting, CLI automation and browser journeys, with independent
cross-review of failure paths.

## Journey and delivered behavior

| User step | Behavior and verification |
| --- | --- |
| Download | Published v0.2.0 checksum and manifest verified separately from the unpublished candidate |
| Install in a project | Extracted prebuilt worker copied into a fresh project, without npm or a source checkout; native and Docker setup exercised |
| Configure feature folder | Custom requests/features path, template, safe relocation and restart checked |
| Create request | Discoverable template and revision-guarded create/edit/validate/submit CLI; drafts remain inactive |
| Execute | Serial worker admission, explicit request state updates, failure/retry/cancellation and patch review |
| Before/after | Unique attempt identity, durable start boundary before provider invocation, matching terminal observation and cumulative known consumption |
| Inspect many runs | History request browser and Execution evidence view; filtered all-matching analysis, bounded cursor pages, full JSON records and CSV export |
| Automate | JSON command catalog, typed flags, stable timeout/error behavior, explicit revision guards and provider setup |

The SQLite run ledger survives session deletion and restart without automatic
history eviction. Retries retain earlier attempts and clear current result links.
Feature-folder exports use immutable run-specific names; the ledger is authoritative
for every attempt, including runs a folder watcher did not observe between fast
retries. Feature-managed retry captures the preceding terminal evidence first.

Provider adapters normalize reported usage from Codex, Claude, OpenAI and
Anthropic. Unknown counters and cost remain null; genuine reported zero remains
zero. Cache counters are subsets of normalized input, and partial counters have
independent coverage. No model-price table or subscription cost is invented.

## Review findings corrected

- A configured feature folder was absent from worker History; it now has searchable
  files, accepted request records, current source inspection and task/evidence links.
- Local execution lacked durable per-attempt evidence and multi-run analysis.
- Queued wait time, retry attribution and current result links could refer to an
  earlier attempt; identities now bind admission, execution and folder exports.
- Failed evidence persistence could relabel a successful patch; execution outcome
  and persistence warnings now remain separate.
- Cancelled terminal attempts cannot start again, and failed retry admission does
  not mark the original session queued.
- Archive/restore updates no longer mutate immutable run-result timestamps.
- Cursor exports no longer mix incompatible paging arguments, and private pending
  responses/downloads are discarded after access expiry or navigation.
- Browser filters, selected details and refreshes preserve the user's context.
- Shutdown now drains executions and final feature reconciliation before disposing
  the run database; the final native journey exposed the incorrect previous order.

## Evidence and qualification

The published archive's basic native and Docker project journeys passed. Its
manifest identifies commit 5edfb8a3afc3fb4f97de1b827cb14bb007c816a2, with tar SHA256
027960d5770b25cd563ea9c3ceb39e42244adeb2ee1fab7f446903823cf5807f. That release does
not have the new local run ledger. The downloaded installer --no-start passed
with NODE_USE_ENV_PROXY=1 in this managed network environment.

The candidate is a local dirty-tree qualification artifact, not a published
release. Its package and copied-app fixtures make no paid provider requests.

[CLI lifecycle evidence](../evidence/2026-10-14-worker-lifecycle-cli/results.json)
records a failed request, explicit retry, reported fixture usage, nullable cost,
all-matching analysis, CSV/JSON export and exact evidence surviving restart.

[Native feature lifecycle evidence](../evidence/2026-10-14-worker-lifecycle/feature-lifecycle-results.json)
records three reserved attempts, two actual scripted-provider executions, a queued
cancellation without an execution pair, immutable prior evidence and no replay.

The [interactive lifecycle gallery](worker-lifecycle-journey.html) embeds 15
screenshots across 1440, 390 and 320 pixels with view and width selection,
fullscreen inspection and a downloadable synthetic metrics dataset. Request files
are live local fixtures; the 120-run analysis data is explicitly synthetic.
[Browser results](../evidence/worker-lifecycle-browser-results.json) confirm all
120 exported rows at every width, no horizontal overflow and no page errors.

Final checks:

- `npm run typecheck`: passed.
- `npm test`: rebuilt all three apps; 674 passed, one PowerShell-specific skip,
  zero failures (675 tests total).
- Extracted candidate project-worker native and Docker journeys: passed with
  required run-evidence schema, immutable restart data and clean-shutdown checks.
- Extracted generic runtime native and Docker journeys: passed; Docker wrapper
  operated without host Node, repeated setup and preserved task/worker identity.
- [Package qualification](../evidence/2026-10-14-worker-lifecycle-package/qualification.json)
  records archive verification, runtime provenance and explicit published/candidate separation.
- Release CI adds the installed-project request and metrics gate on Linux/macOS.
- Workflow generation, strict documentation links and whitespace checks: passed.


## Limits and operating contract

These are local worker-session executions, including local follow-ups to remote
sessions. Original orchestrator lease snapshots retain their existing contract.
CPU/RSS measure the worker Node process, not model subprocesses or remote model
hardware. Recovery observations do not invent a lost execution endpoint. An
admission watermark excludes new runs during pagination; already admitted running
records may still change state while pages are read.

Patch mode produces a reviewed-file patch and does not automatically modify the
project. Successful provider output is not evidence that tests passed or a feature
was accepted. Native provider fixtures qualify POSIX behavior, not Windows CLI
execution, provider quotas, real billing or live model quality.

The [complete lifecycle tutorial](../tutorials/worker-feature-lifecycle.md) and
[metrics reference](../reference/worker-run-metrics.md) ship inside the runtime
archive. No release was published by this pass.
