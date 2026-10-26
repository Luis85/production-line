# Monitor long-running worker sessions

A local model invocation has a six-hour execution budget by default. Inspect its
measurements in **Metrics**; use **Settings → Queue & duration** to adjust the
elapsed-time warning and maximum execution duration. The warning defaults to
one hour; it does not stop work. The maximum is a separate deadline, configurable from one second to 24 hours.
Provider-side limits can still end an invocation earlier.

The worker captures the execution budget with each dispatched prompt. Changing
settings affects later invocations, including an explicit answer or resume; it
does not extend an invocation already queued or running. Provider identity, model,
instruction and retained conversation remain attached to that invocation. A stopped
or failed request requires deliberate continuation; see
[answer and resume](answer-and-resume-worker.md).

## Set a deployment-wide limit

Set `WERK_WORKER_MAX_RUNTIME_MS` in the worker process environment before starting
it. For example, `21600000` means six hours. It must be a decimal integer from
`1000` to `86400000`; an empty or invalid value fails startup. This override takes
precedence over the saved execution setting. Settings identifies its environment
source and disables editing that limit. Change or remove the variable and restart
the worker to change it. Resource warning settings remain editable.

Use the actual worker service/container environment. Exporting a variable in a
client shell does not configure an already-running worker, and a Docker launcher
does not implicitly forward every host environment variable.

## Interpret the measurements

The worker samples every ten seconds. Metrics shows active warnings, measurement
age and retained alert history; Workboard shows the active task.
The measurements describe the **worker Node process**, not the model CLI child,
remote provider or account. Missing readings remain unavailable. A stale snapshot
must not be interpreted as a fresh healthy measurement.

| Measurement | Meaning |
| --- | --- |
| RSS | Memory resident in the worker process; compared with the smaller known host/process memory capacity. |
| Heap | V8 heap use compared with V8's heap limit. |
| Available memory | Node's estimate of memory available to this process, when supported. |
| CPU | CPU time over a monotonic sampling interval; percentage normalized by available parallelism. This does not measure a container's CPU quota. |
| Free disk | Available bytes on the filesystem containing the worker state directory. |
| Elapsed time | Monotonic time for the active serial execution, independent of wall-clock adjustments. |

Default warnings are RSS at 85%, heap at 90%, CPU at 90% sustained for 30 seconds,
free disk below the larger of 256 MiB or 5%, and execution lasting one hour.
Pressure alerts use recovery margins to avoid repeated threshold chatter.
Warnings do not cancel, retry or change model permissions. An idle non-streaming
provider is not automatically declared hung.

## Read alerts through the interface

From the installed project worker CLI:

```sh
node runtime/bin/apps/worker/cli.mjs resource status --state-dir state/worker
node runtime/bin/apps/worker/cli.mjs resource events --after 0 --limit 100 --state-dir state/worker
```

These commands inspect the running worker without making a provider call.
For project agent invocation, see [Claude/Codex integrations](project-agent-integrations.md).

Authenticated `GET /api/resources` returns policy, the latest snapshot, active
alerts and sampling/persistence error indicators. `POST /api/resources` with
`{"action":"events","after":0,"limit":50}` returns numeric alert transitions.
Follow `nextAfter` while `hasMore` is true, then retain the cursor for polling.
Deduplicate by sequence or event ID. The journal retains the latest 1,000
transitions; `gap` and `oldestAvailableSequence` tell a consumer when history has
expired. Opening and resolving an alert are separate events with one alert ID.

A resource journal initialization failure blocks startup readiness: resolve its
state-directory permissions, storage or journal error before restarting. Unsupported
statistics and sampling failures instead produce unavailable/degraded measurements
while the initialized worker remains running. Runtime journal write failures surface
`persistenceError`; do not assume alert history was durably recorded while it is set.

A restart closes prior process alert episodes with reason `worker_restarted` and
samples the new process. Unknown readings do not resolve an active pressure alert.
Structured service logs also report alert transitions, but collector retention is
separate from this bounded journal. No external notification destination is
configured automatically.

For multi-run token and cost analysis use [run evidence](../reference/worker-run-metrics.md).
Resource alerts are operational diagnostics, not a billing ledger. Subscription
balances and provider subprocess resource totals are unavailable.

## Stop, back up and restart

Stop through the normal worker lifecycle command or service supervisor. Shutdown
stops the sampler, drains its current sample and closes journals. Preserve the
complete private state directory, including interaction, run and resource SQLite
journals and sidecars. Stop every writer before a filesystem backup. Start only
one worker owner for that state.

After restart, inspect pending questions and interrupted work. A checkpointed
result can be reconciled without another model call; an uncertain in-flight call
needs an explicit resume and can incur another provider invocation. Readiness
means the service initialized, not that a remote model is making progress. See
[twelve-factor boundaries](../explanation/twelve-factor.md).
