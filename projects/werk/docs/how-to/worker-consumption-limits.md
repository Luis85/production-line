# Set a worker consumption limit

Set a daily or monthly token allowance and give the worker a percentage of it.
For example, an allowance of 1,000,000 tokens with a 50% worker share gives this
worker a 500,000-token budget. Choose the allowance yourself; Werk does not infer
it from a subscription plan or measure your personal usage outside the worker.

The allowance covers this worker's model invocations across its configured
providers: Chat, approved-file and shared feature tasks, automated reviews, and
live native Codex assignments. Separate workers have separate ledgers; their
budgets are not pooled.
Tokens measure model input and output, not money or subscription messages. A
50% allocation therefore does not guarantee half of a provider's subscription
quota remains available for personal use.

## Configure in the webview

Open **Dashboard → Consumption limits**, then **Configure consumption limits**.
Enable **Limit this worker’s consumption**, choose the daily or monthly UTC
period, and enter the total allowance and worker percentage. Expand
**Model call reservation** to adjust the amount held before each invocation.
Select **Save consumption limits**.

The summary shows reported usage, outstanding reservations, remaining worker
allowance and the period reset time. If another operator changes the policy,
your draft remains visible; select **Discard edits and reload** before reconciling
it with the current settings. Saving a policy does not reset recorded usage.

## Configure from the command line

Start the worker, then save this as `consumption.json` in your project:

```json
{
  "consumption": {
    "enabled": true,
    "period": "daily",
    "allowance": 1000000,
    "workerPercent": 50,
    "perRunReservation": 10000
  }
}
```

Apply and inspect it with the installed worker CLI:

```sh
node bin/apps/worker/cli.mjs consumption configure --file consumption.json
node bin/apps/worker/cli.mjs consumption status
```

Use `--state-dir PATH` to select another local worker. For a remote worker, use
`--url` and an explicit private `--token-file`, as described in the
[portable apps reference](../reference/portable-apps.md). `--file -` reads JSON
from stdin. Both commands return JSON; inspection makes no model request.

| Setting | Meaning |
| --- | --- |
| `enabled` | Enforce the budget for new model invocations. Defaults to `false`; usage is still recorded. |
| `period` | `daily` resets at 00:00 UTC; `monthly` resets at 00:00 UTC on the first day of each calendar month. |
| `allowance` | Total configured allowance in whole input + output tokens; positive safe integer. Default: 1,000,000. |
| `workerPercent` | Whole percentage from 1 to 100. Default: 50. The worker allocation rounds down to whole tokens. |
| `perRunReservation` | Tokens held before starting one model invocation. Positive whole number no larger than the worker allocation. Default: 10,000. |

The configuration file uses the `consumption` wrapper, just as provider and
queue configuration use their settings wrappers. Send the complete policy.
Invalid settings leave the saved policy unchanged. This is a saved worker setting;
editing a client shell's `.env` does not change a running worker's allowance.

## Understand reservations and usage

Before a real model invocation starts, the worker durably reserves the configured
amount. A new invocation waits when there is less than one reservation available.
Choose a reservation large enough for the model calls you expect; it is a planning
buffer, not a provider-enforced maximum output length.

A completed invocation replaces its reservation with reported input + output
tokens. Cache-read and cache-write tokens are already included in normalized input
and are not added a second time. While an invocation is active or its final usage
is uncertain, the worker charges the larger of its reservation and the known token
count. Retries, continuations and automated model reviews are further invocations.
Git operations, status inspection and simulated execution do not consume this
model-token budget.

A provider may only report usage after completing a response. That response can
exceed the worker's remaining allocation. The worker stops further starts when the
allocation is exhausted; it cannot undo tokens already consumed. For API tool
loops, it also checks known usage before requesting another model response.

Usage belongs to the UTC window in which the invocation started, including a
response that finishes after the boundary. Changing the daily/monthly period
recalculates the current window from retained invocation times. Changing provider,
restarting, disabling limits or deleting a task does not erase the ledger. Usage
before this installation began tracking is not backfilled; inspect
`trackingStartedAt` when first enabling limits after an upgrade.

## Diagnose a waiting worker

Accepted work stays queued when consumption prevents it from starting. It becomes
eligible automatically when the next UTC window begins or a saved policy makes
enough budget available. A manually paused queue stays paused. An interrupted or
failed model call is not automatically retried; use the normal explicit
[answer/resume or retry workflow](answer-and-resume-worker.md).

`consumption status` reports `workerAllowance`, `measuredTokens`,
`reservedTokens`, `chargedTokens`, `remainingTokens`, active and uncertain
invocation counts, and the current `periodStart` / `periodEnd`. `reservedTokens`
is the portion of held reservations not yet covered by measured usage;
`chargedTokens` combines measured usage and that outstanding portion.

| `reason` | What to do |
| --- | --- |
| `disabled` | Usage is recorded, but this policy does not restrict starts. |
| `available` | Enough budget remains for another reservation. Other queue or provider checks can still prevent execution. |
| `insufficient_reservation` | Wait for the next UTC window, increase the allowance/share, or deliberately reduce the reservation. |
| `exhausted` | Wait for the next UTC window or increase the allowance/share. |
| `unmeasured_usage` | A completed, failed, cancelled or interrupted invocation has incomplete final usage. Wait for the next UTC window, or explicitly disable enforcement after considering the unknown consumption. |
| `accounting_unavailable` | Repair access to the worker's private accounting storage and restart. New model calls remain blocked, even when limits are disabled. |

Unknown usage is never treated as zero. A restart marks an unfinished invocation
uncertain; increasing its allowance does not resolve missing usage. Disabling and
re-enabling limits preserves that uncertainty for the same window. Providers that
do not report complete token counts can therefore run once and then leave the
worker waiting while limits are enabled.

The ledger is stored as `worker-consumption.sqlite` in the private worker state
directory. Preserve it and its SQLite sidecars when backing up the stopped worker;
see [backup and restore](upgrade-backup.md). Do not delete accounting state to
resume work.

## HTTP contract

Authenticated `GET /api/consumption` returns the status above with
`schemaVersion: 1`, the complete `policy`, and `accountingAvailable`.
Authenticated `POST /api/settings` accepts the same JSON wrapper as the CLI.
A client can also send `expectedConsumption` containing the complete policy it
last read; a stale baseline returns a conflict rather than overwriting another
operator's changes.

For per-run evidence and provider coverage, see
[worker run metrics](../reference/worker-run-metrics.md). The separate
[execution-duration limit](monitor-long-running-worker.md) controls elapsed time.
