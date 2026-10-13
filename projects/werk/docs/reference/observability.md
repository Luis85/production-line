# Observability and monitoring contracts

These contracts describe local service diagnostics and current observations.
They do not configure external alerting, telemetry exporters, a tracing backend
or live coding-provider monitoring. Execution remains `mock`.

## Health and diagnostic surfaces

| Service / endpoint | Authentication | Meaning |
| --- | --- | --- |
| Factory `GET /healthz` | Public | Process/service health and database schema version |
| Orchestrator `GET /healthz` | Public | Process health, mock mode and database schema version |
| Worker `GET /healthz` | Public local status service | 200 only for `idle`/`executing`; 503 for other states including `starting`, `disconnected`, `stopping` |
| Worker `GET /status` | Public local status service | Diagnostic JSON remains 200 while the status server is reachable, even when the worker is disconnected |
| Worker `GET /` | Public local status service | Read-only local worker view |
| Factory/orchestrator `GET /guide` | Public | Standalone, read-only entity/navigation guide; no API calls or administrative actions |

Keep worker status on trusted local interfaces. A service health response does
not prove that a task completed or a coding provider is connected. The guide is
static explanation; the authenticated service webviews show live state.

## Line capabilities

Admin-authenticated `GET /v1/capabilities` on an orchestrator returns the same
capability object as `GET /v1/overview` under `capabilities`. Query parameters are
not accepted on the dedicated capability endpoint.

| Field | Contract |
| --- | --- |
| `schemaVersion` | `1` |
| `project` | This orchestrator's configured task/enrollment project |
| `execution` | `mock` |
| `context` | `unbound` or `pinned` |
| `intake` | Unbound: `structured_task`, `requirement_ref`; pinned: `requirement_ref`, `pinned_iteration` |
| `providers` | Distinct registered mock labels from `claude`, `codex`; not live execution guarantees |
| `profiles` | Up to 64 distinct `{id, provider}` entries |
| `profilesTruncated` | Whether additional registered profiles were omitted |
| `capacity.kind` | `observed` |
| `capacity.observedAt` | Time of the capacity observation |
| `capacity.workers` | Nonnegative `total`, `online`, `offline`, `slotsTotal`, `slotsBusy`, `slotsAvailable` counters |

Capacity describes the current observation, not a reservation or a quota promise.
Profile registration can outlive the worker's online session. An older line
without capability data is represented as `null`/unknown by Factory, not assigned
invented capabilities. System startup fetches and validates each line's capability
contract and expected project before creating Factory registrations. Task intake
also rejects a project different from that orchestrator's configured project,
including in unbound mode.

## Orchestrator worker detail

Admin-authenticated `GET /v1/workers/:id` returns:

- `id`, `project`, `profiles`, `seen` and `online`.
- `config: {maxParallel, order, maxAttempts}`.
- Up to 8 `activeTasks`, each `{id, status: "running", attempt, expiresAt, profile}`,
  plus `activeTasksTruncated` when more active records exist.

`seen` and `expiresAt` are server epoch-millisecond values. Online status is based
on last contact relative to the server's worker TTL. The response excludes tokens,
token/config hashes, lease secrets and raw task payloads. A missing worker or one
outside the configured project returns 404. Query parameters are not accepted.
This bounded projection is distinct from the worker's own local `/status` DTO.

## Service event schema

Factory, orchestrator and worker emit structured diagnostic records on stderr:

```json
{"schemaVersion":1,"time":"2026-10-12T12:00:00.000Z","service":"orchestrator","level":"info","event":"request_finished","requestId":"8ec4cdca-0437-42f7-94b4-994c084de24d","method":"GET","route":"/v1/workers/:id","status":200,"durationMs":3}
```

Every service record has `schemaVersion: 1`, ISO timestamp `time`,
`service: factory|orchestrator|worker`, `level: info|warn|error` and `event`.
Supported events are:

| Event | Additional service-record fields / purpose |
| --- | --- |
| `request_finished` | Generated `requestId`, allowlisted `method`, normalized `route`, `status`, nonnegative integer `durationMs` |
| `internal_error` | Generic internal request failure |
| `lease_reaper_error` | Lease reconciliation failure |
| `attempt_error` | Worker attempt failure |
| `state_write_error` | Worker state persistence failure |
| `connection_lost` / `connection_restored` | Worker connection transition |
| `service_listening` | Worker status service started listening |

Handled HTTP requests receive a generated UUID in `x-request-id`; incoming request
IDs are ignored. Known dynamic routes replace identifiers with `:id`; unclassified
routes become `unmatched`, and unusual methods become `OTHER`. Query strings,
request/response bodies, headers, bearer tokens and raw exception messages are not
service-log fields. A connection closing before response completion is recorded
with diagnostic status 499; it does not mean the client received HTTP 499.

Completed-request severity is `error` for 5xx, `warn` for 4xx and `info` otherwise.
Duration measures server-side request handling, not model usage or end-to-end
client latency. Other events contain no request ID or arbitrary message field.
A failed diagnostic sink does not replace the application's response.

## Capture and retention

Native `--log-output file|stream|both` (or `WERK_LOG_OUTPUT`) selects local files,
foreground stream or both; default is `file`. Explicit flags override the environment.
Stream mode does not create supervisor log files, including nested line files;
required databases and worker journals remain durable. A system stream forwards
sanitized Factory, line and worker diagnostics to its top level.

Native supervisors accept only allowlisted service records, remove unknown
fields, and drop raw, malformed or oversized child lines. They store the event
under `entry` in a `service_log` lifecycle record with the child role/slot or ID.
Lifecycle records also include startup, readiness, shutdown and child-exit events;
the complete runtime log is not exclusively the service event schema.

Each native runtime log in `file`/`both` mode rotates while running at **1 MiB**, retaining the current
`runtime.jsonl` and one `runtime.jsonl.previous`: at most 2 MiB of normal generated
log content per supervisor/line runtime. The system supervisor/Factory and each
line have separate logs. State and log files remain private.

Docker release services use the `local` logging driver with `max-size: 1m` and
`max-file: 2` per container. This configures per-container retention; Docker's
storage metadata is separate from application log payload size. Container streams
may also include ordinary process diagnostics. No external collector is started.

Logs are bounded diagnostics, not the authoritative task event history, immutable
snapshot journal or a full audit archive. Use the
[monitoring procedure](../how-to/monitor-runtime.md) to correlate the relevant
service, request and persisted task evidence.


## Operational metrics and derived alerts

Factory and orchestrator expose authenticated `GET /v1/monitoring` (JSON) and
`GET /metrics` (Prometheus text format 0.0.4). Admin, operator and viewer credentials
may read them; enrollment and worker credentials cannot. Query parameters are
rejected. Give the collector a viewer credential and send it in the Authorization
header. Worker status exposes the corresponding `/monitoring` and `/metrics` on
its existing trusted local status port; keep this port off public ingress.

The JSON contract is `schemaVersion: 1`, `service`, ISO `observedAt`, `thresholds`,
`metrics` and `alerts`. Each alert has a stable `code`, `severity` (`warning` or
`critical`), fixed `message` and actionable `remediation`. Responses contain no
project, task, worker or Factory identifiers, URLs, credentials, task payloads or
provider errors. Metric names are fixed, with no labels. All measurements are
gauges, including moving-window counts; do not apply counter `rate()` to them.
The Prometheus view additionally exposes `werk_alerts_active`.

| Owner | Gauges |
| --- | --- |
| Orchestrator | `werk_tasks_queued`, `werk_tasks_running`, `werk_tasks_blocked`, `werk_tasks_review`, `werk_queue_oldest_age_seconds`, `werk_leases_overdue`, `werk_lease_expirations_window`, `werk_attempt_failures_window`, `werk_workers_online`, `werk_workers_offline` |
| Factory | `werk_lines_registered`, `werk_lines_available`, `werk_lines_unavailable`, `werk_lines_stale`, `werk_observation_partial`; available-line subtotals for the task and worker gauges above, excluding queue age, failures and leases |
| Worker | `werk_worker_connected`, `werk_worker_active_tasks`, `werk_worker_heartbeat_errors`, `werk_worker_last_contact_known`, `werk_worker_last_contact_age_seconds`, `werk_outbox_measurement_available`, `werk_outbox_pending`, `werk_outbox_oldest_age_seconds` |

An empty line reports zero gauges. Factory omits task/worker subtotal gauges when
there are no available measurements; it never reports unreachable work as zero.
`werk_observation_partial=1` means some registered lines could not be observed or
aggregate arithmetic overflowed. Stale but available lines retain their measured
values and set `werk_lines_stale`; check both indicators before using totals.
Worker outbox gauges are omitted if its journal measurement is unavailable, with
`werk_outbox_measurement_available=0` and an `outbox_unknown` alert.

Queue age uses the oldest queued task's original creation time, including retries.
Overdue leases are a read-only observation; scraping does not reap them. Lease
expiration counts use durable `lease_expired` events. Failure counts use terminal
`failed` or `interrupted` evidence received in the configured window; they exclude
successful simulated/review outcomes and do not infer provider billing or quality.
Workers are online only while their last contact is younger than the lease TTL.
An outbox item remains pending until server acknowledgement and removal from its
local durable queue. Its age uses the immutable capture time, including restart
and recovery. Heartbeat error totals are process-local and reset at restart.

| Environment setting | Default | Meaning |
| --- | --- | --- |
| `WERK_ALERT_QUEUE_AGE_SECONDS` | `300` | Oldest queued task warning age |
| `WERK_ALERT_FAILURE_WINDOW_SECONDS` | `900` | Window for terminal failures and lease expirations |
| `WERK_ALERT_FAILED_ATTEMPTS` | `3` | Failure count warning within that window |
| `WERK_ALERT_OUTBOX_AGE_SECONDS` | `120` | Oldest undelivered evidence warning age |
| `WERK_ALERT_OUTBOX_PENDING` | `100` | Pending evidence count warning |
| `WERK_ALERT_STALE_OBSERVATION_SECONDS` | `120` | Factory line observation warning age |

Values are decimal integers from 1 to 8640000; invalid values fail startup without
printing their contents. Set them before native start/up or Docker startup; the
same allowlisted settings reach every service. Changing Docker settings requires
recreating its services with the same state. Thresholds appear in each JSON report
so a collector can verify the effective configuration.

At most six line alerts, three Factory alerts and three worker alerts are derived
per observation. Codes are `queue_stalled`, `no_online_workers`, `workers_offline`,
`attempt_failures`, `lease_expirations`, `tasks_blocked`, `lines_unavailable`,
`line_observation_stale`, `partial_observation`, `worker_disconnected`,
`outbox_backlog` and `outbox_unknown`. Alerts clear when the observation recovers or
the event window expires. A threshold breach does not itself change `/healthz`:
queued work and retained evidence are operational signals, not process liveness.
No notification sender, metrics history store or external alert manager is started.
