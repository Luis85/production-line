# From a downloaded worker to feature evidence

This tutorial installs a standalone worker in a project, submits a Markdown
feature request, inspects its execution evidence and compares later runs. The
same workflow is available to a human or an AI agent through the JSON CLI. You
do not need a Factory, orchestrator, npm install or source build.

You need Node.js 24 and a verified Werk runtime archive. For real execution, you
also need a configured provider: a signed-in Codex/Claude CLI on the worker's
machine, or a supported API account. Installing Werk does not sign in to a model
provider. The examples use Codex CLI on Linux/macOS; Windows native workers use
an API provider. See [provider setup](../how-to/use-worker-webview.md#connect-claude-or-codex).

## 1. Download and verify the package

Download a versioned runtime `.tar.gz` or `.zip` and `SHA256SUMS` from
[Werk Releases](https://github.com/Luis85/production-line/releases). Verify the
archive checksum and extract it into its own directory. Choose the runtime asset,
not GitHub's source-code archive. The [release reference](../reference/releases.md)
describes verification and the installer. If using the installer for this journey,
pass `--no-start` so it downloads without starting a Factory fleet.

The commands below refer to `/path/to/werk-release`. Check the installed worker's
`schema`: the version you downloaded must include the `run list`, `run get`,
`run analyze` and `run export` commands to follow the metrics portion. A release
without those commands can execute feature requests but cannot supply this local
run ledger retroactively.

## 2. Install the worker in your project

Open a terminal in the destination project and run:

```sh
node /path/to/werk-release/bin/apps/worker/cli.mjs init --features-dir requests/features --provider codex-cli --port 4100
node bin/apps/worker/cli.mjs feature folder get
node bin/apps/worker/cli.mjs schema
node bin/apps/worker/cli.mjs start
node bin/apps/worker/cli.mjs status
```

Setup copies the complete worker app, creates private `.werk` state and the
configured request folder, and installs a draft template. It preserves existing
configuration. The worker runs independently of the extracted release directory.
Use `run` instead of `start` to keep it in the foreground; Ctrl+C stops it.

The status response reports the webview address. The local CLI resolves the
worker's private access token itself; you do not need browser login or to copy a
token into a command. For browser access, use the local token-file path printed
by startup. [Project setup](../how-to/project-worker.md) also covers Docker,
multiple projects and safely changing the feature folder later.

## 3. Connect the model provider

Sign in to Codex CLI as the account running the worker. Save a private JSON file
named `provider.json`, substituting the installed CLI's absolute path:

```json
{"provider":{"id":"codex-cli","executable":"/absolute/path/to/codex"}}
```

Apply and check it:

```sh
node bin/apps/worker/cli.mjs settings set --file provider.json
node bin/apps/worker/cli.mjs provider check --id codex-cli
node bin/apps/worker/cli.mjs settings get
```

The check reports installation/login status without making a model request.
Successful login does not prove available quota or model access. Settings output
redacts saved credentials. For API providers, supply the provider ID, model and
API key in a private input file or stdin; do not commit that input file.

## 4. Create a feature request

For a small coding example, create `greeting.txt` in your project with the text
`Hello`. Save the following as `request-draft.md` outside the watched folder:

```markdown
---
schemaVersion: 1
title: Improve the greeting
status: draft
mode: patch
provider: codex-cli
paths:
  - greeting.txt
---
# Goal
Change the greeting to Hello Werk.

## Acceptance criteria
- greeting.txt contains Hello Werk followed by a newline.
- No other project file changes.
```

Create and validate it through the worker:

```sh
node bin/apps/worker/cli.mjs feature create --name greeting.md --markdown request-draft.md
node bin/apps/worker/cli.mjs feature validate --name greeting.md
node bin/apps/worker/cli.mjs feature get --name greeting.md
```

A draft does not execute. The response includes a `revision`; copy it into the
submission command below. Revisions prevent an agent or editor from overwriting
someone else's newer request. You can instead copy and edit the installed
`requests/features/_templates/feature-request.md` template directly.

## 5. Submit and follow execution

```sh
node bin/apps/worker/cli.mjs feature submit --name greeting.md --if-match REVISION
node bin/apps/worker/cli.mjs feature wait --name greeting.md --timeout-ms 60000
node bin/apps/worker/cli.mjs feature result --name greeting.md
```

The watcher waits for a stable save, captures the accepted input once and updates
the Markdown frontmatter as the request moves through the queue and execution.
Only one model request executes at a time. `queue pause` holds new execution;
`queue resume` releases it. A second request can wait behind the current one.

The terminal status for a successful patch request is `review`. Werk saves the
patch and result; it does not apply the patch, run your tests, publish or merge
it. Inspect the saved evidence, run `git apply --check` and apply the patch when
appropriate, then verify the actual project behavior yourself.

`feature wait` returning a terminal state is not proof of success: inspect that
state. A timeout leaves work running and returns a machine-readable
`wait_timeout` error. Inspect it again or cancel explicitly. Failed/cancelled
requests can be retried using their current revision; a retry has new execution
evidence and does not replace the previous attempt. See the
[feature-request contract](../reference/feature-requests.md).

## 6. Inspect the before/after pair

Use the request's returned `taskId` to find its executions:

```sh
node bin/apps/worker/cli.mjs run list --task-id TASK_ID
node bin/apps/worker/cli.mjs run get --id RUN_ID
```

The paired snapshots show execution state, worker-process resources and cumulative
known consumption before and after the run. Per-run provider usage is also
separate in the record. The before snapshot is saved before the provider starts.
A failed or cancelled execution also has evidence; recovery after a process crash
is labelled interrupted and cannot reconstruct lost measurements.

`null` means not measured. A provider may report token counts without reporting
cost. CLI subscription balance, model quality, provider subprocess resource use
and unreported charges cannot be inferred from these snapshots. Read
[run metrics](../reference/worker-run-metrics.md) for measurement scope and coverage.

In the webview, open **History** to inspect **Project requests** and **Execution
evidence**. You can move from a request to its conversation/evidence, inspect
paired snapshots and review the reported consumption. The existing orchestrator
snapshot history remains a separate source.

## 7. Compare many runs and export them

Create additional requests with distinct filenames. Run analysis over all retained
local executions, or filter by provider, task, outcome and timestamp:

```sh
node bin/apps/worker/cli.mjs run analyze
node bin/apps/worker/cli.mjs run analyze --provider codex-cli
node bin/apps/worker/cli.mjs run list --limit 50
node bin/apps/worker/cli.mjs run export --limit 100
```

Analysis reports totals together with the number of measured runs. Missing usage
is excluded from measured totals, not silently treated as zero. A mean duration
covers only runs with a measured duration. Memory is a boundary gauge, not a
continuous execution peak. Local evidence persists across restarts and session
cleanup; preserve the complete worker state when backing up.

List/export responses are bounded pages. Continue with `nextCursor`, preserving
the same filters, until it is null. Save each JSON page or combine its `rows` in
your own analysis tool. Do not call the first page a complete export when it has
a next cursor. The webview supplies the same filters and a downloadable export.

## 8. Stop, restart and automate

```sh
node bin/apps/worker/cli.mjs stop
node bin/apps/worker/cli.mjs start
node bin/apps/worker/cli.mjs feature list
node bin/apps/worker/cli.mjs run analyze
```

The request lifecycle, accepted input and run evidence survive restart. A stopped
worker does not process newly saved requests until it starts again.

An AI agent can follow these same commands. Start with `schema`, parse JSON
results and stderr errors, preserve returned identifiers/revisions/cursors,
check terminal outcomes, and use explicit cancel/retry commands. Avoid guessing
private file layouts or mutating server-owned frontmatter. The
[portable CLI reference](../reference/portable-apps.md) lists the complete command
catalog and exit-code contract.
