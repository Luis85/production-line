# Deliver a local Feature Request for human review

For the primary release-archive journey in a dedicated worker home, follow
[archive to main checkout](worker-home-to-main.md). This tutorial covers the
separate direct-in-project local intake setup.

This tutorial installs a worker in a Git project, submits a canonical Markdown
Feature Request, runs a real project check and inspects the resulting local Git
candidate before human acceptance. The daemon owns execution; Markdown and the
webview control the same request. A Factory or orchestrator is optional.

The selected pilot is native Windows with Claude Code. The
[acceptance ledger](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reports/2026-10-20-local-delivery-acceptance.md) records which
platform/provider checks have actually run; source fixtures do not qualify a real
Claude account. The commands below use an installed runtime that contains the
local-delivery iteration. An older download may expose only the legacy proposal
workflow; check its version and matching documentation first.

You need Node 24, Git with an existing initial commit, a verified Werk runtime and
a supported provider connection. Use a disposable repository for your first
attempt. Installing Werk does not install or sign in to a model provider. For a
shared commit-and-push team queue, use [shared intake](../how-to/shared-feature-intake.md)
instead of enabling two intake owners for the same request.

## 1. Download and install the worker

Download a versioned runtime archive and `SHA256SUMS` from
[Werk Releases](https://github.com/Luis85/production-line/releases), verify them,
and extract into a separate directory. See the [release reference](../reference/releases.md).
Run from your project, replacing the release path:

```sh
node /path/to/werk-release/bin/apps/worker/cli.mjs init --intake local --features-dir requests/features --provider claude-cli --port 4100
node bin/apps/worker/cli.mjs feature folder get
node bin/apps/worker/cli.mjs schema
node bin/apps/worker/cli.mjs start
node bin/apps/worker/cli.mjs status
```

Setup preserves existing configuration and installs the complete worker app,
private state, environment files and request templates. Use `run` instead of
`start` for foreground operation. In the browser, unlock the printed local URL
with `WERK_WORKER_TOKEN` from the private project `.env`; do not put it in a URL,
request note or commit. The local CLI resolves its token itself.

## 2. Authorize the project and connect Claude

Inspect the detected repository and explicitly authorize it:

```sh
node bin/apps/worker/cli.mjs repository status
node bin/apps/worker/cli.mjs repository accept --discovery-id ID_FROM_DISCOVERY
```

Copy the exact current discovery ID. If native execution is still preparing,
wait until `repository status` reports `nativeWork.state: "ready"` before accepting
it. An existing explicit assignment already authorizes the repository. Local
candidate delivery does not require a remote;
repository synchronization and shared publication have their own configuration.
The selected committed baseline excludes unrelated staged or unstaged source.

Sign in using Claude's official CLI as the OS account that runs Werk. In
**Settings → Providers & accounts**, select Claude Code, its absolute executable
path and the explicit account authentication mode. Alternatively, select API-key
mode and supply the key privately. Never rely on implicit billing fallback.

A portable settings command accepts a private JSON file such as this Windows
example; substitute the actual path:

```json
{"provider":{"id":"claude-cli","authenticationMode":"cli-account","executable":"C:\\path\\to\\claude.exe"}}
```

```sh
node bin/apps/worker/cli.mjs settings set --file provider.json
node bin/apps/worker/cli.mjs provider check --id claude-cli
```

A successful read-only check establishes reported installation/login state, not
quota or task success. Follow the [provider and native Windows prerequisites](../how-to/use-worker-webview.md#connect-claude-codex-or-cursor)
for process containment and runtime limitations. Keep `provider.json` private,
especially when it contains an API key.

## 3. Prepare a verifiable change

Create `greeting.txt` containing `Hello` followed by a newline. Create
`test/greeting.test.mjs` with this deterministic check:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the greeting is updated', () => {
  assert.equal(readFileSync('greeting.txt', 'utf8'), 'Hello Werk\n');
});
```

Commit only the tutorial input and check:

```sh
git add -- greeting.txt test/greeting.test.mjs
git commit -m "Add a greeting change acceptance check"
```

The check deliberately fails before implementation. In **Settings → Tools & MCP**,
authorize repository file access and add an enabled **Required feature check**
using the machine's absolute Node executable and arguments
`["--test", "test/greeting.test.mjs"]`. `node -p process.execPath` prints that
executable path. Save the permissions before submitting work. See
[implementation setup](../how-to/implement-feature.md) for fixed command presets.

Review the generated `.werk/delivery-policy.json`. Its feature profile requires
semantic readiness, bounds repairs and protects existing verification inputs.
Commit the policy to the baseline before submitting the request:

```sh
git add -- .werk/delivery-policy.json
git commit -m "Configure the worker delivery policy"
```

In **Settings → Project delivery**, select this repository, inspect the committed
configuration and approve its exact digest. Saving a draft does not commit or
approve it. The [headless policy commands](../reference/delivery-policy.md#configure-without-opening-the-webview)
provide the same inspection and guarded approval from the CLI.

Check that the selected baseline includes both the tutorial files and policy.
An uncommitted policy, missing local approval or unavailable semantic assessment
holds implementation with an actionable reason. A new request can still be saved
as a draft. Request text cannot remove these requirements or grant tools. See
[readiness setup](../how-to/configure-delivery-readiness.md) for the required
assessment and how to answer its findings.

## 4. Create and submit the Feature Request

Save this as `request-draft.md` outside the watched folder:

```markdown
---
schema: worker.request/v1
id: FR-GREETING
title: Improve the greeting
intent: draft
quality_profile: feature
priority: normal
depends_on: []
mode: patch
provider: claude-cli
paths:
  - greeting.txt
---
# Improve the greeting

## Outcome
Show the product name in the greeting.

## Scope
Change greeting.txt to Hello Werk followed by a newline.

## Acceptance criteria
- The greeting contains Hello Werk followed by a newline.
- No other implementation file changes.

## Boundaries
Preserve the existing test and unrelated project files.

## References
The committed test/greeting.test.mjs checks the actual file bytes.

## Answers

<!-- worker:begin -->
## Worker

Status: Draft
<!-- worker:end -->
```

Import and validate the draft:

```sh
node bin/apps/worker/cli.mjs feature create --name greeting.md --markdown request-draft.md
node bin/apps/worker/cli.mjs feature validate --name greeting.md
node bin/apps/worker/cli.mjs feature get --name greeting.md
```

Drafts do not invoke a model. Copy the returned file `revision` when submitting:

```sh
node bin/apps/worker/cli.mjs feature submit --name greeting.md --if-match REVISION
node bin/apps/worker/cli.mjs feature wait --name greeting.md --timeout-ms 60000
```

You can instead edit the canonical file's `intent` to `submit` and save it.
Repeated saves keep the same identity. Local mode waits for a stable save;
shared mode requires the committed/pushed handoff. A file revision guards an edit;
the numeric requirement revision and delivery run ID identify accepted work.

## 5. Follow execution and accept the candidate

Open the request on Taskboard and inspect its lifecycle, execution phase, next
action and activity. The worker prepares an isolated workspace from the explicit
baseline, implements the approved file change and executes the required check.
Failed checks feed the bounded repair allowance; exhaustion retains work and
reports the blocker. A completed model response cannot manufacture a passing check.

If the worker asks a question, answer its ID in the request's user-owned Answers
section or the supported request interface. The worker reassesses the changed
revision. Do not edit generated status or create another request to answer it.
See [answer and resume](../how-to/answer-and-resume-worker.md).

Use **Pause after this step** to wait at a bounded boundary. **Interrupt now** and
**Cancel request** show their pending result until execution cessation is known.
The project queue pause affects new starts. Closing the browser does not stop the
daemon. Uncertain operations must be reconciled before retry.

A verified candidate reaches **Ready for human review**. Open its Markdown review
note, by default in `feature-reviews`, and inspect the request revision, baseline,
branch, commit, diff, required-check evidence and manual criteria. For the recorded
candidate identifiers, inspect:

```sh
git diff BASELINE_COMMIT CANDIDATE_COMMIT
git show CANDIDATE_COMMIT:greeting.txt
```

Record every required human outcome with a supporting note, then accept that
exact candidate in request review. The [equivalent Markdown decision](../reference/feature-requests.md#candidate-decisions-and-execution-controls)
uses the current package's criterion IDs, requirement revision, full candidate
commit and a unique command ID. Missing manual results or stale evidence reject
acceptance. Use request changes for feedback; an accepted/cancelled request needs
explicit reopening before more work.

With a review-only policy, human acceptance completes the Feature Request. New
web-generated `localMerge: true` policy instead keeps delivery in progress until
the separately authorized local main-checkout merge is confirmed. The local note
and candidate commit alone do not prove that merge, a pushed branch or a hosting-service
PR. To enable worker-managed local merge, commit and locally approve `localMerge: true`
before new work is admitted; an older accepted policy does not silently gain that
authority. Inspect the main checkout path, branch and current head before permitting
that exact candidate; ordinary manual Git integration remains available. `feature wait` observing a stopped execution is not itself a success or
acceptance assertion. A wait timeout leaves work running.

## 6. Inspect the before/after pair

Use the request's returned `taskId` to find its executions:

```sh
node bin/apps/worker/cli.mjs run list --task-id TASK_ID
node bin/apps/worker/cli.mjs run get --id RUN_ID
```

Each provider invocation has its own before/after pair; one delivery can contain
several invocations and verification steps. The paired snapshots show execution state, worker-process resources and cumulative
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
private file layouts or editing generated status instead of using the documented
user-owned command fields. The
[portable CLI reference](../reference/portable-apps.md) lists the complete command
catalog and exit-code contract.
