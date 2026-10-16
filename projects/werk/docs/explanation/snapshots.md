# Worker snapshots and time-series semantics

This page describes orchestrator lease-attempt snapshots. Local chat and
approved-file tasks use a separate [run-evidence contract](../reference/worker-run-metrics.md),
which can record provider-reported usage and request-gate evidence. Shared Git
publication uses those local runs and its own durable claim/publication journal;
it does not turn a leased snapshot into proof of merge.

## Identity and durability

Every **attempt**, including review rework, has one immutable before/after pair.
The schema version, task, iteration source, attempt, worker, profile, configuration
hash and lease/run ID identify it. `capturedAt` comes from the worker;
`receivedAt` and the monotonically increasing sequence come from the server.
Use server receipt time for ingestion ordering and monotonic time for durations.
Do not silently trust a client's clock for cross-machine latency.

Local files are flushed to disk and atomically renamed into place, then queued
for upload. Journal flushing is serialized. The worker verifies the
acknowledgment's snapshot ID and SHA-256 against the
exact posted JSON before removing an outbox entry; an invalid acknowledgment
leaves evidence pending. Acknowledgment never deletes the original. Repeated payloads are
idempotent; changed content for an existing phase is rejected. The server indexes
a SHA-256 of the parsed JSON serialization. This is a content identity, not a
signature or independent attestation of the worker's measurements.

The canonical original also belongs in the project's feature PR:
`.factory/runs/TASK_ID/attempt-N/LEASE_ID/{before,after}.json`.
The lease journal writes these into `--project-dir` when supplied; a lease-fenced
PR publisher is still required to commit and push them. Shared-intake feature
branches and review notes are a separate implemented publication path.

## Measurements

| Dimension | Contract / target | Leased-attempt measurement |
| --- | --- | --- |
| Execution | Start/end, queue time, duration, timeout, interruption, retries | Before/after times, monotonic duration, outcome, attempt |
| Resource use | Per-process/group CPU, RSS, memory peak, disk/network where attributable | Node worker CPU, RSS, heap, process-lifetime peak RSS, host 1-minute load |
| Health | Heartbeats, lease loss, disconnects, event-loop lag, provider login/limits | Last contact, cumulative heartbeat errors, process-lifetime event-loop P95, recovery flag |
| Provider usage | Input/output/cache tokens, model/version, context size, account quota | Unavailable for mock and the leased Codex adapter; local-run evidence is separate |
| Cost | Reported variable cost, estimated cost, subscription allocation separately | Null; no invented API price or allocation |
| Quality | Build/test outcomes, counts, coverage, lint, security, check evidence | Explicit `not_run`, null measurements; no success inference |
| Provenance | Git base/tested/head associations, manifest hash, tools/skills, policy/config | Configuration/prompt hashes, runtime/adapter versions and available pinned source/context; review change sets carry validated base and patch identity |
| Delivery | Draft creation, ready-for-review, review rounds, merge, deployment | Target Git-event stream; absent from mock completion |

Worker metrics are **worker-scoped**, especially when tasks overlap. A CPU delta
over an attempt interval includes other activity in that worker process. Do not
sum those deltas as exclusive task CPU. RSS is an instantaneous gauge;
`peakRssBytes` and event-loop P95 cover process lifetime, not solely one task.
Host load is environmental context, not an allocation to a feature. Future CLI
metrics should include child-process/cgroup scope and sampling-window metadata.

Two snapshots provide boundary evidence, not continuous observability. The worker
resource monitor separately samples resource gauges and records durable alerts;
its scope and history must be interpreted separately from these snapshot pairs. Never infer an intra-task memory peak,
continuous availability, or idle-machine health solely from task boundaries.

## Costs and quality without false precision

`null` means unavailable or not measured; zero means measured zero. Provider
reported cost, a catalog-price estimate, and amortized subscription cost are
separate series, with currency, source, rate-date and allocation-policy version.
Subscription accounts shared across profiles require a shared accounting key to
avoid counting the same subscription multiple times. Do not sum currencies.

Publish totals together with coverage: number of runs with measured costs divided
by eligible runs. Exclude missing values from means, report the missing fraction,
and keep simulated runs separate from real ones. Cost per merged feature requires
verified merge events and all its rework attempts, not just its last run.

Quality gates are enforced by the host workflow. A model's statement that tests
passed is not evidence. Record check command IDs, exit status, duration, artifact
digests and the code commit tested; associate CI/approval with the final PR head.
Do not confuse a mock `simulated` outcome with quality or delivery success.

## Failure, recovery and publication

An ordinary timeout/cancel/error captures an after snapshot in the termination
path. If the process or host dies, a real after snapshot may be impossible. On
restart the journal creates a clearly marked recovered interruption record for
incomplete local pairs. Exact lost timing/counters are null. If the machine never
returns, the orchestrator records the missing after snapshot and lease expiry;
it must not forge a worker measurement to make coverage look complete.

The worker continues renewing its lease through telemetry upload and completion
acknowledgment. Reporting has at most three immediate attempts per cycle with
100/200 ms backoff; replaying a durable terminal record does not rerun the adapter.

Late snapshots are accepted for an authenticated historical attempt. Task
completion and publication still require a current lease. A new retry gets a
new attempt/pair; records from an old attempt cannot overwrite it. A recovered
interruption cannot complete a task successfully. Completion responses must identify the same attempt and expected status. An
abandonment acknowledgment must show released ownership for that attempt, or a
newer assignment returned by an idempotent replay; it must never authorize changes
to that successor. The worker validates this response before recording the
acknowledged outcome. A finished local attempt does not imply restored
connectivity when the polling loop remains disconnected.

In the target leased PR workflow, the final after snapshot is taken before publication. It cannot contain the
hash of its own enclosing commit. PR ID, published commit, CI, review feedback
and merge outcome are additional events attached by the orchestrator. This also
captures review/rework timing without rewriting evidence in earlier commits.

## Analysis and views

`GET /v1/snapshots` supports project, worker and task filters. Default ascending
order uses `after` for incremental export; `order=desc` uses `before` to page
backwards from the latest records. CLI `snapshots list` exposes the same contract.
Use `nextCursor` in the selected direction while `hasMore` is true; retain schema
version and source/receipt times in external analysis.

The portfolio filters by project, worker, iteration, time window and
outcome. It shows duration P50/P95 with sample count, outcome counts, RSS,
event-loop delay and snapshot JSON/digests. A scatter plot avoids implying a
continuous series between unrelated workers. Above 500 points the plot is
sampled, while all selected loaded after-snapshots still contribute to statistics.
Cost and quality remain explicitly unknown/not run.

The view loads the newest 10,000 records and discloses truncation. The inspector
shows the newest 40 records. Use the paginated API for complete historical export.
Pair completeness covers only phases observed in the selected window: running
attempts and filter boundaries can produce incomplete pairs. It is not proof
that every scheduled attempt produced telemetry. Live refresh runs every five
seconds and can be paused. Worker status refreshes every three seconds; exported
HTML is frozen and performs no polling. Worker acknowledged-simulation and error
counts are process-lifetime counters, not persistent portfolio totals.

Production portfolio dashboards should separate:

- Delivery: feature-merge throughput, cycle/review time and iteration integration.
- Performance: queue/run P50/P95, per-stack and per-provider trends, sample size.
- Quality: check pass/fail, review rounds, escaped defects and evidence coverage.
- Cost: measured/estimated/allocated totals, currency and missing-data coverage.
- Health: online/draining/offline workers, slot saturation, stale leases,
  disconnects, provider auth/limits and missing snapshot pairs.

Compare like cohorts. Different feature sizes, tech stacks, review practices and
missing telemetry make a single worker leaderboard misleading.
