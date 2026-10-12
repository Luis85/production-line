# Monitor a runtime and diagnose failures

Start with the service that owns the symptom: Factory for hierarchy and line
availability, the line's orchestrator for tasks/worker records, and the worker's
status view for its local connection and execution state. These views complement
each other. The [observability reference](../reference/observability.md) defines
the exact health, capability and log contracts.

## Learn the views without changing state

Open `/guide` on a running Factory or orchestrator, for example
`http://127.0.0.1:3100/guide` for the system tutorial's Factory or
`http://127.0.0.1:3000/guide` for a single line. This standalone guide explains the
entities and navigation without login, live API calls or administrative actions.
It does not inspect your deployment. Use the actual service webviews for current
state; the [entity map](../explanation/core-entities.md) identifies their owners.

## Establish readiness

For a native system using the shipped example:

```text
node werk.mjs system status --file examples/system.yaml --json
node werk.mjs system doctor --file examples/system.yaml --json
```

If you edited the YAML, use the saved state directly for maintenance:

```text
node werk.mjs system status --state-dir .werk-system/demo-system --json
node werk.mjs system doctor --state-dir .werk-system/demo-system --json
```

For one native line, use `node werk.mjs status --json` and `doctor --json` with the
same state directory as its start. Check `state` as well as the result: a stopped
native deployment can pass preflight checks without being running.

Docker uses `bash werk-docker.sh system status` / `system doctor` with the same
`--file`, `--environment docker` and state selection as startup. PowerShell uses
`./werk-docker.ps1`. Inspect `ready` and the exit status. Neither an open HTTP
socket nor the worker's `/status` response alone means it is ready for work:
worker `/healthz` returns 503 while starting, disconnected or stopping.

## Inspect a line and worker

Open the line from Factory and authenticate to that line. Inspect its advertised
capabilities and observed capacity, then the registered worker's detail and active
tasks. An authenticated client can read `GET /v1/capabilities` and
`GET /v1/workers/WORKER_ID`; these have no dedicated new CLI commands.
The existing orchestrator `overview` command includes the same capabilities.

Check observation time and truncation flags. A registered Claude/Codex label is
mock configuration, not a live provider session; available slots are a current
observation, not a reservation. A worker can be registered yet offline. Use its
own status page to inspect connection loss, then the line's task events and
snapshots to determine what the server accepted.

Task input must use the line's configured project, including an unbound mock
line. A Factory or sibling line token does not authenticate to this line.
Supply tokens through your trusted client's environment, not URLs or log messages.

## Correlate a failed request

Capture the response's generated `x-request-id`, time, HTTP status and action.
Find the corresponding `request_finished` service log. The route is normalized,
so task/worker IDs and query strings are not logged. A client-supplied request ID
is not reused. Generic error events identify the failure category without raw
exception text; correlate them by service and time as well as the finished request.

This is per-service request correlation. It does not install distributed tracing,
an external alert manager or a log aggregation server.

## Read bounded logs

Native `file` mode is the default. Select `--log-output stream` or set
`WERK_LOG_OUTPUT=stream` on native foreground start/up for a service manager or
collector, with `--json` for uniform JSON-line envelopes. Stream mode includes
sanitized nested line/worker logs and does not create supervisor log files. Use
`both` to retain rotating local files as well. Configure external retention in the
collector; streaming alone does not install one.

With `file`/`both`, native single-line logs are at `<state>/logs/runtime.jsonl`. A system uses
`<system-state>/logs/runtime.jsonl` for its supervisor/Factory and
`<system-state>/lines/<id>/logs/runtime.jsonl` for each line. For example, read the
last 100 lines of `.werk-system/demo-system/lines/alpha/logs/runtime.jsonl` with
`tail -n 100` in Bash or `Get-Content -Tail 100` in PowerShell.

Native service records are nested under `entry` in a `service_log` lifecycle
record. Keep the current file and `runtime.jsonl.previous` together when collecting
evidence. Rotation occurs while running; older entries are replaced.

For a single Docker line, use `bash werk-docker.sh logs --json` or the PowerShell
wrapper's `logs --json`. For a Docker system, use its generated Compose file and
saved project name from the release root:

```bash
werk_state='.werk-system/demo-system'
IFS= read -r werk_project < "$werk_state/docker-project"
docker compose --project-directory . --file "$werk_state/docker-compose.json" --project-name "$werk_project" logs --no-color --tail 100
```

```powershell
$werkState = '.werk-system/demo-system'
$werkProject = (Get-Content -LiteralPath "$werkState/docker-project" -Raw).Trim()
docker compose --project-directory . --file "$werkState/docker-compose.json" --project-name $werkProject logs --no-color --tail 100
```

Adjust the state path if configured differently. The system wrapper does not have
a `system logs` action. Docker retains bounded logs per service; its output can
also contain ordinary process diagnostics, so select service records by their
schema rather than treating every line as an application event.

Keep logs private and review them before sharing. Never attach credential files,
state backups, bearer headers or request bodies to a diagnostic report. Log
retention is diagnostic retention, not the durable task/evidence history. If state
needs recovery, follow [backup and restore](upgrade-backup.md).


## Collect metrics and respond to alerts

Use a dedicated viewer principal for a collector. Read `/v1/monitoring` from the
Factory and each orchestrator with its own bearer credential; read worker
`/monitoring` only over the trusted local connection. Never put tokens in URLs.
For Prometheus, use the same service origins with `metrics_path: /metrics` and
`authorization.credentials_file` pointing to a protected token file. Supply
instance identity through collector target configuration: Werk intentionally does
not add task, project or worker labels to metric output. Keep monitoring private,
or use the same authenticated TLS boundary as other operator APIs.

Begin with a 30-second scrape interval. Alert on missing scrapes as well as Werk
conditions: an unreachable process cannot report its own failure. For Factory,
check `werk_lines_unavailable`, `werk_lines_stale` and
`werk_observation_partial` before trusting aggregate task counts. On a line,
inspect old queued work and online capacity together. Three failed terminal
attempts within the default 15-minute window warrant reviewing snapshots; one
lease expiration warrants checking connectivity and worker load. A worker outbox
older than two minutes warrants restoring evidence delivery, preserving its files.
Use the JSON report's remediation text to choose the next diagnostic step.

To change sensitivity, set the documented `WERK_ALERT_*` environment values before
starting the owning runtime. For example, `WERK_ALERT_QUEUE_AGE_SECONDS=600` warns
when queued work is ten minutes old. Native supervisors forward only the six
validated alert settings; Docker Compose forwards these settings explicitly.
Restart/recreate services with their existing state, then read `thresholds` from
`/v1/monitoring` to verify the effective values. Do not solve an active incident by
raising thresholds before understanding the cause.

Derived alerts have no persistence or delivery queue. Configure notification
routing, retention and a sustained-condition duration in your chosen collector.
For example, alert when `werk_worker_connected == 0` persists for two minutes,
and distinguish that from absent scrape data. All exported values are gauges;
`werk_attempt_failures_window` is already a count over a moving window, so use it
directly rather than computing a rate. The [reference](../reference/observability.md)
defines missing-value semantics and every stable alert code.


Headless operators can use the same read-only report through application CLIs:

```text
node src/factory/dist/factory/cli.js monitoring --url http://127.0.0.1:3100
node src/orchestrator/dist/orchestrator/cli.js monitoring --url http://127.0.0.1:3001
```

Supply the viewer credential through `WERK_FACTORY_ADMIN_TOKEN` or
`WERK_ADMIN_TOKEN` respectively. These existing client environment names also
accept a viewer token; they do not grant an administrator role. Commands return
the JSON monitoring contract. Use [access control](../reference/access-control.md)
for principal setup, rotation and audit-event interpretation.
