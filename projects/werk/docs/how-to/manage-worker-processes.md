# Manage development services and worker processes

Use **Worker health → Services & execution processes** to inspect processes started for
local Feature Requests. A development service, such as a preview server or
watcher, can remain available while the team reviews the result. Finite provider,
command, MCP and Git executions keep their existing deadlines and cancellation
behavior.

## Grant a development service

1. Assign the project repository and prepare a Feature Request with a pinned task
   worktree. A plain Chat session without that worktree cannot start a service.
2. Pause new starts and finish or cancel queued and running work. Open
   **Settings → Tools & MCP → Development services**.
3. Add a named preset with an absolute executable path and fixed arguments as a
   JSON array. For a committed Node script, select **Use worker Node.js** and
   enter `["scripts/dev-server.mjs", "--host", "127.0.0.1"]`. The script and its
   dependencies must exist in the request's worktree. Use the actual executable
   on Windows, rather than a `.cmd` shell wrapper.
4. Set the maximum lifetime and the worker's maximum concurrent services. Expand
   **Readiness signal and automatic restart** if the process reports a known
   ready message or should retry unexpected exits.
5. Enable both **Allow models to manage development services** and the preset's
   individual grant, then save tool access. Resume new starts.
6. Ask the Feature Request to use the preset when its preview or watcher is
   needed. Inspect its service card in Worker health and follow the Feature Request
   link to see the owning work.

The grant starts disabled. An ordinary command preset does not authorize a
background service. The model selects a granted preset; it cannot append
arguments, change the executable, supply an environment or choose a different
working directory. The worker rechecks the current grant and pinned worktree
before every start or restart. Services run with the worker account's file and
network permissions; a worktree is not an operating-system sandbox.

The service receives a minimal process environment, without the worker's tokens
or provider credentials. Logs are project output and remain private worker data;
service tools can return that output to the Feature Request's selected model.

## Choose the lifetime and restart policy

| Setting | Behavior |
| --- | --- |
| Maximum concurrent services | 1–16 across this worker; default 4. Separate from model execution slots. |
| Maximum lifetime | 1 second–24 hours from the original start. Restarts keep the original expiry. |
| Ready text | Optional literal text in stdout or stderr. Matching it records reported readiness; it is not an application health check. |
| Startup wait | 0.1–60 seconds, no longer than the lifetime. Applies when ready text is configured. |
| Restart attempts | 0–5. Automatic and operator-requested restarts share this allowance. Zero disables restarts. |
| Delay before automatic restart | 0.1–60 seconds. Each retry rechecks the grant and worktree. |

A successful model turn does not stop its service: the team may still need the
preview during review. The worker stops it on expiry, operator stop, grant
revocation, loss of the owning request/worktree, task cancellation or failure,
and worker shutdown. Archiving the request also ends its services. Pausing new
model starts or locking the browser does not stop an existing service.

Unexpected nonzero process exits can trigger the bounded restart policy. A lost
service host or interrupted worker does not trigger automatic reattachment or
replay. After restarting the worker, inspect retained interrupted records before
requesting another start. The worker never uses a saved operating-system PID as
authority to control a process.

## Inspect and control a service

The card shows its Feature Request, state, remaining lifetime, readiness,
restart allowance and latest exit. **Running** means the process is alive.
Use the project's own acceptance checks to establish whether it works.

- **Inspect logs** opens bounded stdout/stderr as inert text. The worker retains
  up to 128 output entries and 16 KiB per service. A gap means earlier output was
  evicted; this is not a complete log archive.
- **Stop service** asks for confirmation and ends the owned process group. It
  leaves the Feature Request and retained work available.
- **Restart service** asks for confirmation and uses the remaining restart
  allowance and lifetime. A disabled control explains which condition prevents
  restart. A changed preset requires a new explicitly granted service.
- **Retry unconfirmed operation** resends the original operation ID and revision
  after a lost acknowledgement. Use this action rather than issuing a new
  restart when the previous outcome is uncertain.
- **Include ended processes** shows retained service records and completed finite
  executions. Up to 50 service records are retained in private worker state.

If a private service host stops responding, the worker limits how long it waits
for startup or shutdown and requests forced cleanup of that owned host. When
closure still cannot be confirmed, the service stays **Stopping**, keeps its
capacity slot and explains the uncertainty. A replacement or restart remains
blocked; inspect the current state and retry stopping it. A later confirmed
closure updates the retained record.

New service controls are disabled while readings are stale. Refresh and inspect
the current state before confirming a new operation. Background polling keeps
button labels stable. Closing the page does not change the service lifetime.

## Understand the resource readings

The two summaries measure separate groups: granted services, and observed finite
executions. They exclude the worker's own Node.js process shown in **Worker &
host**. Service groups include their small supervision host. On Linux, the
worker reads group CPU and resident-memory counters from `/proc`; service
samples normally arrive every five seconds and finite execution samples every
second while active.

CPU time is a sum of cumulative counters for the processes currently visible in
each group. It is not CPU utilization, elapsed time or provider consumption. It
can decrease when group members exit. Summed resident memory can count shared
pages more than once. Coverage says how many active groups supplied usable
measurements; missing measurements remain unavailable, never inferred zero.
These counters do not measure remote API servers or other applications.

Finite execution observation covers instrumented local task/model/delegation
scopes, including their commands, MCP subprocesses and Git work. It is not a
machine-wide process inventory. Worker-owned maintenance can appear without a
Feature Request or session. Provider discovery probes and unrelated machine
processes are excluded; separate orchestrator adapters are not covered by this
local execution instrumentation. It retains
100 completed entries plus active launches in memory for the current worker
runtime; a worker restart clears them. A completed entry's measurement is its
last live sample, not a final lifetime total. Cancel a finite execution through
its Feature Request rather than a process-level button.

## Platform and interruption boundaries

Service lifecycle control is supported on Linux, macOS and Windows. Linux
process-group measurements may be unavailable when `/proc` access is restricted.
On macOS and Windows the lifecycle remains visible but group CPU/memory are
unavailable in this increment.

On POSIX, a service's private host owns the process group and holds a lifetime
pipe from the worker. Losing that pipe, including an abruptly terminated worker,
triggers group cleanup. On Windows, the contained host uses a kill-on-close job.
If the service host itself disappears unexpectedly, cleanup may be unconfirmed;
the worker reports interruption instead of claiming the service was stopped.
Programs that deliberately escape their process group are outside this
containment boundary.

Finite executions keep the existing runner: cancellation, timeout and normal
leader exit clean up their owned descendants. An abrupt POSIX `SIGKILL` of the
worker has no equivalent lifetime-pipe guarantee for finite executions. This
view does not retrofit a guardian or reattach those processes after restart.

See [model tool permissions](manage-model-tools.md),
[implement a feature](implement-feature.md), and the
[run metrics contract](../reference/worker-run-metrics.md) for related setup and
measurement semantics.
