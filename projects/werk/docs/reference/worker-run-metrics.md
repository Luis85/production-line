# Local worker run metrics

Local run evidence covers worker-managed Chat turns, approved-file tasks and
feature requests, including follow-ups in those sessions. It is independent of
the orchestrator's lease/snapshot journal. An original remote assignment keeps
its orchestrator evidence; a later local conversation turn is a separate local
execution, not a replay of that assignment.

## Metrics webview

Open **Metrics** to inspect one worker. Its sections have different time scopes:

| Section | What it measures |
| --- | --- |
| Current activity | The shared execution slot, occupied local places and separate accepted-assignment buffer; includes preparation reservations |
| Token allowance | Reported input/output tokens, outstanding reservations and remaining share in the configured daily or monthly UTC window |
| Worker & host | Latest worker-process CPU, resident memory and heap; state-volume free space and whole-machine memory |
| Execution activity | Retained attempts accepted in the last 24 hours, 7 days, 30 days or all retained time; defaults to 7 days |

The execution-window selector affects **Execution activity** only. Its bounds are
captured when the request starts and shown under **About these measurements**.
They filter acceptance time, not completion time. Retries, follow-ups, gate
reviews and rework can produce multiple attempts for one Feature Request.
Outcome counts therefore do not measure delivered features. Token/cost totals
use finished attempt records; durations show their measured subset and exclude
queue time. Each summary shows coverage so missing measurements stay visible.

The allowance is a configured worker budget, not a provider subscription balance;
usage in everyday tools outside this worker is not measured. Reservations are
separate from reported usage, and an active call can exceed its reservation.
Incomplete accounting keeps remaining allowance unverified. See
[consumption limits](../how-to/worker-consumption-limits.md) for the admission policy.

Resource samples normally update every 10 seconds. CPU and memory describe the
worker's Node.js process and exclude model subprocesses; CPU needs two samples.
Host memory includes other applications. Free space describes the whole state
volume, not the size of Werk's files. These are current observations, not a
historical resource time series. **Alerts & task monitoring** retains warning
transitions separately, up to 1,000 events; these do not provide a resource time
series.

Read times and stale/error labels belong to each source. Background refreshes
retain the last matching values without animating action buttons. Pausing browser
updates does not stop the worker, and displayed measurements continue to age.
Changing the execution window clears the previous window's summary until its
replacement arrives. Missing or failed measurements never become measured zero.

Use **View taskboard** to inspect work, **Manage consumption limits** or **Worker
settings** to change configuration, and **Explore all retained attempts** to open
History's detailed records and export controls. **Runtime & connection details**
keeps machine identifiers and diagnostics out of the primary reading path. See
[the webview guide](../how-to/use-worker-webview.md) for workspace navigation.

## Storage and identity

The private worker state contains `worker-runs.sqlite`. Each admitted invocation
has a unique run ID, durable sequence and session attempt number. `taskId` and
`sessionId` link it to its owning task. A retry or follow-up creates a new run;
prior evidence is retained. Session deletion does not delete run history, and
there is no automatic run-history eviction. Back up the complete stopped worker
state, including the SQLite database and any WAL files, rather than copying only
one file from a running process.

Evidence begins when this capability is installed; old transcripts are not
retroactively converted into measured snapshots. Records contain identity,
provider/model, title, outcome and measurements. They do not store prompts,
responses, approved file contents, provider credentials or raw provider logs.
Task titles remain private worker data.

## Lifecycle and paired snapshots

| Stage | Evidence |
| --- | --- |
| Queued | Durable identity/admission time; `before` and `after` are null |
| Execution starts | After acquiring the single execution slot, persist `before` before invoking the provider |
| Completed/review/failed/cancelled | Persist `after`, terminal outcome, per-run usage and measured duration/resources |
| Cancelled while queued | No provider execution or before snapshot; cancellation is explicitly identified |
| Worker restarts with an unfinished run | Mark interrupted with a recovery observation; unavailable execution-end timing/CPU remain null |

Before and after observations use the same fields: capture time, measurement
kind, state, process resource measurements and cumulative known consumption.
`measurement` distinguishes an execution boundary from recovery or cancellation.
An after observation made during recovery is not a measurement of the lost
execution's exact endpoint. Existing before evidence is not rewritten.

Consumption at the before boundary includes known usage from earlier completed
runs. At the after boundary it includes the current run's reported usage. The
run's separate `usage` object contains only that invocation's usage. Do not sum
cumulative snapshots to calculate total consumption; use analysis or the per-run
usage values instead.

## Meaning of measurements

| Field | Meaning |
| --- | --- |
| `resources.scope: worker_process` | The Node worker process; excludes provider subprocesses and remote API resources |
| RSS/heap | Memory gauges at the capture boundary, not the peak during the run |
| CPU user/system microseconds | Cumulative counters for this process instance |
| `resourceDelta` | Counter difference between boundaries in the same process; includes worker housekeeping during that interval |
| `durationMs` | Monotonic execution duration; null if the endpoint could not be measured |
| `queueDurationMs` | Measured wait before acquiring the slot; separate from execution duration |
| `inputTokens`, `outputTokens` | Normalized provider-reported token counts, when available |
| `cacheReadTokens`, `cacheWriteTokens` | Subsets of input, not additional tokens to add again |
| `providerReportedCostUsd` | Provider-reported USD amount; consult `costBasis` to distinguish estimates, billed amounts, unknown provenance and unavailable cost |

`null` means unknown or invalid/unavailable; zero means reported/measured zero.
The worker does not infer a price from a model name. CLI subscription balance,
shared account usage outside this worker, quality and merge/delivery success
remain unknown unless measured elsewhere. A successful model response is not a
passing build or accepted feature.

Reported usage can be retained on failed calls when the provider emits it before
failure. Missing, malformed or unreported usage stays unknown. Analysis exposes
per-field coverage counts so a token total and cost total can have different
coverage. A partial measured total is not the account's total bill.

## HTTP and CLI

Execution evidence uses authenticated `POST /api/runs`; the public health/Prometheus
endpoints do not expose local task history. Use the worker CLI or the same
worker access session as the webview.

| Action | CLI | Result |
| --- | --- | --- |
| List | `run list` | Bounded chronological page of run records and continuation cursor |
| Inspect | `run get --id RUN_ID` | One record with original before/after observations |
| Analyze | `run analyze` | Aggregates over all matching retained records, independent of page size |
| Export | `run export` | One JSON page with the full records; `--format csv` flattens identity/usage and includes snapshot JSON cells |

All outputs use `schemaVersion: 1`. The JSON page includes `rows`, `total`, `asOf`,
`nextOffset` and `nextCursor`. The analysis response reports outcomes, completed
pairs, per-field consumption coverage, measured duration count/mean and scoped
resource totals. Empty or entirely unmeasured averages/totals remain null.

Filters: `--session-id`, `--task-id`, `--provider`, `--kind`, `--outcome`,
`--since` and `--until`. Timestamp filters select admission time (the run's
`acceptedAt`) and use ISO timestamps with an explicit `Z` or offset. Providers are `codex-cli`, `claude-cli`, `openai-api` and
`anthropic-api`; kinds are `chat`, `local` and `orchestrator`. Outcomes are
`queued`, `running`, `completed`, `review`, `waiting_input`, `escalated`, `failed`, `cancelled` and `interrupted`.

For HTTP, use the same camelCase field names (`sessionId`, `taskId`, `asOf`),
`action: "list"|"get"|"analyze"|"export"`, and `id` for inspection. `limit`
is 1–100 with a default of 50; `offset` is nonnegative. Inspect the CLI `schema`
for command-specific validation and option support.

## Pagination and analysis boundaries

`asOf` is an admission-sequence watermark, not a timestamp. The first page fixes
membership at that boundary. Follow its opaque `nextCursor` with the same
filters until it is null; do not combine a cursor with an offset or a new
`asOf`. New runs admitted after that boundary do not move the export pages.
Already-admitted running records may finish during traversal, so this is not
historical state replay or a transactionally frozen multi-page export.

JSON is recommended for agents: it preserves nulls, typed fields and continuation
metadata. CSV is a single page and requires deliberate pagination; it should not
be presented as a complete export merely because a file downloaded successfully.
For an exact completed dataset, stop new submissions and let active work finish
before starting the export.

The webview exposes Project requests and Execution evidence inside History.
History filters affect both its displayed list and analysis; the Metrics window
selector is independent.
Measurements, missing coverage and recovered interruptions remain visibly
separate. The [worker lifecycle tutorial](../tutorials/worker-feature-lifecycle.md)
walks through this from a downloaded package.

Questions end one invocation and release the execution slot; an answer starts
another run. Usage checkpoints replace cumulative observations within one run
and can survive interruption. Claude-reported USD is an estimate, not an invoice;
older records without `costBasis` have unknown provenance. See the
[interaction contract](model-interaction.md) for checkpoint and recovery semantics.
