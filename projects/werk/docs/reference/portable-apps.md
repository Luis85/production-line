# Portable Node applications

The runtime release contains `bin/apps/factory`, `bin/apps/orchestrator` and
`bin/apps/worker`. Copy any complete folder into another project's `bin/apps/`.
Each includes its compiled application, webview, CLI and runtime dependencies.
Only **Node.js 24.x** is required. No npm install, source checkout, Docker or sibling
application is needed. CLI subscription providers additionally need their installed,
authenticated executable on the worker machine. Claude Code CLI runs on Linux,
macOS and Windows; Codex CLI requires Linux or macOS. API providers need a configured key and selected model.

From the destination project directory:

```sh
node bin/apps/worker/cli.mjs start --state-dir .werk/worker-a --port 4100
node bin/apps/worker/cli.mjs start --state-dir .werk/worker-b --port 4101
node bin/apps/orchestrator/cli.mjs start --state-dir .werk/line --port 3000 --project demo
node bin/apps/factory/cli.mjs start --state-dir .werk/factory --port 3100
```

Start any subset in any order. `start` returns JSON when the app and authenticated
control endpoint are ready; `run` stays in the foreground for CI, systemd, launchd,
Windows services or containers. Use `--port 0` for an available port and read `url`
from the result. Workers open Chat first; Factory and orchestrators open Dashboard.
Startup returns the private credential **file path**, never its contents. Open the
returned URL and unlock the webview using that file locally. The CLI reads local
credentials itself. Workers may enroll later through `settings set`; Factory can
register an already running orchestrator as a line.

## Initialize a project worker

Run the release worker's `cli.mjs init --project-dir /absolute/project` to install
the app into that project's `bin/apps/worker`, create `.werk/worker.json`, a draft
feature-request template and `.werk/compose.worker.yaml`. Use `--features-dir` to
choose a project-relative folder and `--provider` to choose its default connection.
Run or start from the project directory; the installed worker discovers its project
configuration. `feature template` prints a fresh Markdown template without a running
worker; `feature list` reads the authenticated watcher state. Template output is
Markdown, an intentional exception to JSON CLI output.

See the [project worker guide](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/project-worker.md)
and [feature request contract](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/feature-requests.md).
Each watched folder belongs to one worker state; choose separate feature folders,
state directories and ports for additional workers.

## Assign repositories to a worker

Use Dashboard's **Git repositories** section or
`settings set --file repositories.json` with a top-level
`repositories` object: `{pollMs: 30000, items: [{id, path, remote, branch?, watch}]}`.
Assign existing local Git checkouts; the worker watches/fetches each enabled
repository and only fast-forwards clean bases. Coding tasks use retained worktrees
under each checkout's `.werk/worktrees`. Drain tasks before changing assignments.
Worker JSON passed through `--config` can seed assignments; saved private settings
take precedence after the first start. Git must be installed on the worker host.

The private status endpoint is available with
`api --path /api/repositories`; POST `{"action":"sync","id":"app"}` to sync
one assignment, or omit `id` for all. Local file tasks select the assignment ID
in their existing `repository` field. Assigning repositories does not change
mock execution or give provider Chat arbitrary filesystem tools. See the
[configuration contract](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/configuration.md#assigned-git-repositories).

## Lifecycle and automation contract

Every app supports `help`, `schema`, `run`, `start`, `status`, `stop`, `health`,
`monitoring` and `api`. Help/schema return a JSON command catalog with HTTP methods,
required flags and example bodies. Successful commands write JSON to stdout;
diagnostics go to stderr. `--json` is optional. Exit 0 means success, 2 means invalid
input or API rejection, and 1 means operational failure. No command prompts or
opens a browser. Worker help also reports the local execution-policy environment
variable, bounds, precedence and inspection commands, plus request-gate recovery
semantics. `WERK_WORKER_MAX_RUNTIME_MS` controls each local model invocation,
not the lifetime of a session or a CLI polling deadline. The default is six hours,
with a validated one-second to 24-hour range; a process-environment override wins
over saved private settings and must be removed/restarted before execution edits.
Inspect `settings get` for `executionSource` and `resource status` for admission
conditions. Resource snapshots measure the worker Node process, not provider
subprocess totals or subscription balances. Fleet `workers.execution.timeoutMs`
is a separate deployment policy with its own bounds; see
the release guides `docs/reference/configuration.md` and
`docs/reference/system-definition.md`. `status` distinguishes running, stopping, stopped and unreachable;
unreachable exits 1. A running process is not necessarily connected to its upstream.
Use `health` and `monitoring` to inspect application readiness and current conditions.

```sh
node bin/apps/worker/cli.mjs schema
node bin/apps/worker/cli.mjs status --state-dir .werk/worker-a
node bin/apps/worker/cli.mjs monitoring --state-dir .werk/worker-a
node bin/apps/worker/cli.mjs stop --state-dir .werk/worker-a
```

`stop` authenticates the specific instance and drains/cancels work through the
application's shutdown path. It never kills a stored PID. Repeating stop on a stopped
app succeeds. A second start of an already running instance is rejected, so changed
launch options cannot be silently ignored. After a crash, inspect the private log
and verify that the owning process has exited before removing stale lifecycle
metadata and its lock. Never remove locks from a running app.

State defaults to `.werk/<app>` under the invoking project, outside the copied app.
Use a separate state directory and port for each instance. Keep state private and
out of Git; it includes credentials, transcripts, SQLite databases and results.
Detached operational logs are in `<state>/portable.log`; apply your log retention
policy while stopped. To update: stop, back up state, replace the complete app folder
with a verified release copy, then start with the same state and launch options.
The portable CLI does not automatically replace itself. Copying runtime files never
copies provider credentials or task history. Stop all writers before backing up.

## Give a worker tasks from an AI agent or CI

Configure a provider using `settings set --file provider.json`; files and stdin
contain JSON and are limited to 64 KiB. Subscription login takes place with the
provider's CLI on the host. An example settings document is:

```json
{"provider":{"id":"codex-cli","executable":"/absolute/path/to/codex"}}
```

On Windows, configure Claude Code CLI with its absolute `claude.exe` path and use
`"provider":"claude-cli"` in task input. See the
[Windows Claude requirements](../how-to/use-worker-webview.md#connect-claude-or-codex)
for PowerShell, .NET and process-containment prerequisites. Alternatively, configure
an API connection, for example
`{"provider":{"id":"openai-api","model":"YOUR_SELECTED_MODEL","apiKey":"PRIVATE_API_KEY"}}`,
and use `"provider":"openai-api"` in task input. Keep the configuration file private.

Then write a task document, for example `task.json`:

```json
{"id":"ci-architecture-001","title":"Plan a search page","provider":"codex-cli","message":"Draft acceptance criteria for a search page with filtering."}
```

```sh
node bin/apps/worker/cli.mjs settings set --state-dir .werk/worker-a --file provider.json
node bin/apps/worker/cli.mjs task create --state-dir .werk/worker-a --file task.json
node bin/apps/worker/cli.mjs task get --state-dir .werk/worker-a --id ci-architecture-001
node bin/apps/worker/cli.mjs task send --state-dir .werk/worker-a --id ci-architecture-001 --file followup.json
node bin/apps/worker/cli.mjs task cancel --state-dir .werk/worker-a --id ci-architecture-001
```

`followup.json` contains `{"message":"Describe the next step."}`. Each task owns one
session; follow-ups retain it. Commands address that session directly and do not
change the conversation selected in the browser. Repeating create with the same
explicit ID and original title/provider/message/agent profile returns the existing task; changing
that input conflicts. Omitting ID generates a new task, so do not automatically retry
an ambiguous create without an explicit ID. Follow-up sends are not idempotent;
inspect the transcript before retrying an ambiguous response. Task acceptance does
not mean completion: inspect `session.status`, `chat.busy` and message outcomes.
All chat, file work and remote assignments execute serially. Queue places add waiting
capacity; multiple isolated worker instances provide parallel execution.

For local files use `file-task create --file file-task.json` with an explicit
repository and approved paths:

```json
{"title":"Explain the acceptance rule","instruction":"Add a comment explaining the rule.","provider":"codex-cli","repository":"/absolute/project","paths":["acceptance.txt"]}
```

Inspect `file-task list`, `file-task get --id ID`, or use `file-task action --file`
for taskboard operations. File tasks capture approved input and produce review
patches. They do not apply changes or run tests. `session action --file` supports
rename/archive/delete with the same restrictions as the webview. `settings set`
configures the local queue, provider connections and optional orchestrator:

```json
{"connection":{"enabled":true,"url":"http://127.0.0.1:3000","enrollmentToken":"PRIVATE_ENROLLMENT_TOKEN"}}
```

Use private files or stdin for secrets, never literal credentials in command arguments.
An orchestrator's `component.json` contains separate admin and enrollment tokens.
Only the worker prompts an LLM; higher-level interactions are delegated to a worker.

## Check sign-in and use Docker Agent definitions

`provider check --id codex-cli` (or another provider ID) runs a bounded read-only
CLI sign-in check without prompting a model. API connections report configured
or missing configuration; no paid API request is made. Raw account output is not
returned. Browser access uses its own protected session and is separate from
provider sign-in; bearer-based automation continues to read the private token.

```sh
node bin/apps/worker/cli.mjs provider check --id codex-cli
node bin/apps/worker/cli.mjs definition preview --file preview.json
node bin/apps/worker/cli.mjs definition import --file definition.json
node bin/apps/worker/cli.mjs definition list
node bin/apps/worker/cli.mjs definition delete --id DEFINITION_ID
```

Preview input is `{"yaml":"YAML_TEXT"}`; import adds `"name":"Project reviewer"`.
The returned definition ID can be added to `task create` or `file-task create`
input as `"definitionId":"DEFINITION_ID","agent":"root"`. The task stores an
immutable instruction/model snapshot. Supported OpenAI/Anthropic model references
require a matching worker provider; the definition never silently changes billing.

This is an instruction-profile integration. Preview lists unsupported Docker
runtime features. Only after reviewing them, add `"useInstructionsOnly":true`
to explicitly omit them for the task. Tools, hooks, harnesses, sub-agents, remote
resources and parallel execution are not started. Imports do not expand variables
or load credentials. Each complete JSON request must fit 64 KiB. Definitions stay
in private worker state and persist across restart; all task execution stays serial.

## Manage Factory and orchestrator

Factory commands include `factory list|get|create|update|delete`,
`line list|get|create|update|delete`, `intake list|create|route`, `routing get|set`,
`overview` and `line interact`. Registry mutations require a stable `--key` for safe
retries. Intake creation also requires a key. Example Factory creation:

```json
{"id":"main","name":"Project factory","parentId":null}
```

```sh
node bin/apps/factory/cli.mjs factory create --file factory.json --key factory-main
node bin/apps/factory/cli.mjs factory list
node bin/apps/factory/cli.mjs routing get --id main
```

Before starting Factory, supply each line credential through its named environment
variable, such as `WERK_LINE_ALPHA_TOKEN`, with the orchestrator admin token. Register
a line using `line create --file line.json --key line-alpha`:

```json
{"id":"alpha","factoryId":"main","name":"Alpha","orchestratorUrl":"http://127.0.0.1:3000","webviewUrl":"http://127.0.0.1:3000","tokenEnv":"WERK_LINE_ALPHA_TOKEN"}
```

The Factory reads these credentials at startup; restart it with the new environment
when adding a credential. Registering a line neither starts nor owns its process.
Factory intake bodies contain `factoryId`, `task` and optional `lineId`. Routing
supports automatic capability/capacity matching or manual destinations; without a
compatible live destination intake remains queued. `routing set --id main --file`
accepts `{"mode":"auto","lineId":null,"paused":false}`.

Orchestrator commands include `task create|list|get|events|route`, `workers list`,
`routing get|set`, `overview` and `interact`. Task creation uses `--file` and a stable
`--key`; for example:

```json
{"project":"demo","title":"Implement the requirement","criteria":["Record evidence"],"wikilinks":[],"provider":"codex"}
```

For native Codex work, add optional `"repository":"docs"` to select an assigned
checkout independently of `project`, which stays the line scope. When omitted,
the assignment ID defaults to `project`. Factory intake accepts the same field
inside `task`; successor requests accept it inside `input`. The portable CLI
passes the JSON field through unchanged. It is an assignment ID, not a path or
remote URL. Use `"executionMode":"cli"` for explicit live execution; selecting a
repository alone does not change mock behavior.

Orchestrator `routing set --file` accepts
`{"mode":"auto","workerId":null,"order":"fifo"}`. No workers are required
to accept queued work. Use `schema` to discover command methods and required flags.

The bounded `api` command exposes other existing endpoints, including pagination:

```sh
node bin/apps/orchestrator/cli.mjs api --path '/v1/tasks?limit=100'
node bin/apps/factory/cli.mjs api --path '/v1/intake?factoryId=main'
```

For remote management use `--url` plus a private plain-text `--token-file` or
`WERK_APP_TOKEN`. An explicit URL never receives automatically discovered local
credentials. Use HTTPS across untrusted networks. API permissions and validation
are unchanged: CLI commands call the same application APIs as the webviews.

## Build and qualify

Maintainers run `npm run build` to create all three `bin/apps/` folders, or
`node scripts/build.mjs worker` for one. Generated apps are ignored by Git and included
in runtime release archives. The packaging integration test copies apps to unrelated
projects, starts independent instances on available ports, uses authenticated commands,
checks private state/restart and exercises worker task sessions with a labelled model
fixture. Fixture success does not qualify authenticated live provider execution.


## Worker task and queue maintenance

The worker exposes named commands for users, CI and AI agents. They operate on
explicit IDs and do not change the webview selection, except `session select`.

| Commands | Options / input |
| --- | --- |
| `task list`, `session list`, `file-task list` | Optional `--status STATUS`, `--archived true\|false`; outputs retained tasks and executor/board state. |
| `task get`, `session get` | `--id SESSION_ID`; includes conversation and status. |
| `task create` | `--file PATH\|-`; title, provider, message, optional stable id and definition. Replaying an identical create ID is idempotent. |
| `task send` | `--id SESSION_ID --file PATH\|-`; `{"message":"Follow-up"}` in the existing session. Follow-up/retry requests are not idempotent; inspect history after an uncertain response. |
| `task cancel`, `task retry` | `--id SESSION_ID`; retry only a failed/cancelled chat task, using its last user message. |
| `task rename`, `session rename` | `--id SESSION_ID --title TITLE`. |
| `task archive\|restore\|delete`, `session archive\|restore\|delete` | `--id SESSION_ID`; archive/restore set a state explicitly. Active tasks cannot be archived/deleted. Delete a linked file-task before deleting its protected session. |
| `session select` | `--id SESSION_ID`; explicitly changes the selected webview session. |
| `file-task create` | `--file PATH\|-`; approved-file input contract shown by `schema`. |
| `file-task get\|cancel\|retry\|archive\|restore\|delete` | `--id TASK_ID`; retry uses captured input/files; archive/restore are explicit, repeatable states. |
| `file-task priority` | `--id TASK_ID --priority 1\|2`; queued tasks only. |
| `task wait`, `file-task wait` | `--id ID [--timeout-ms N]`; stopped/action-required polling, default 60 seconds, maximum 24 hours. Inspect status to distinguish success, failure, cancellation or pending input; timeout exits 1 without cancelling. |
| `queue get`, `queue settings` | Executor/session state or redacted configuration. |
| `queue pause`, `queue resume` | Pause/resume execution and new orchestrator claims. Running work finishes; queued work is retained. |
| `queue configure` | `--file PATH\|-`; e.g. `{"board":{"queueCapacity":16,"orchestratorQueue":4,"order":"fifo"}}`. |

Workers always execute serially. Local capacity is 1–64; orchestrator queue
capacity is 0–64. Setting the latter to zero disables remote queuing beyond the
worker's existing immediate capacity behavior. Pausing does not delete queued work.
Existing `session action`, `file-task action`, settings, provider checks, agent
definitions, environment, monitoring and history remain available. Feature-file
management is documented in the [feature-request reference](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/feature-requests.md#cli-management-contract).

Input/API rejection exits 2; operational failure exits 1. CLI commands never
prompt. A successful `wait` means a stopped or operator-action state was observed.
Callers must inspect status and pending input before treating output as work success.


## Worker attempt evidence and export

Every worker-managed model attempt receives a durable run ID. Use `run list` to
inspect attempts independently of the current webview session. Feature Chat and
approved-file requests use the same ledger; follow-ups and retries add new attempts.
Original orchestrator lease snapshots remain separate under `history`.

```sh
node bin/apps/worker/cli.mjs run list --session-id SESSION_ID --limit 50
node bin/apps/worker/cli.mjs run get --id RUN_ID
node bin/apps/worker/cli.mjs run analyze --provider codex-cli --since 2026-10-14T00:00:00Z
node bin/apps/worker/cli.mjs run export --session-id SESSION_ID --format json
node bin/apps/worker/cli.mjs run export --session-id SESSION_ID --format csv
```

`list`, `analyze` and `export` accept `--session-id`, `--task-id`, `--provider`,
`--kind chat|local|orchestrator`, `--outcome queued|running|completed|review|failed|cancelled|interrupted|waiting_input|escalated`,
and inclusive `--since`/`--until` ISO timestamps with explicit timezones.
`list` and `export` return bounded pages: `rows`, `total`, `nextOffset`, `asOf`
and `nextCursor`, with `schemaVersion: 1`. Runs are ordered by admission sequence,
oldest first. `--limit` is 1–100, default 50.
For stable traversal, repeat the same filters and supply the returned `--cursor`
until `nextCursor` is null. New admissions are excluded by the first page's sequence
watermark. Existing running attempts may finish while you traverse; this is not a
historical replay of their earlier state. Numeric `--offset` is also available;
`--as-of` accepts a returned admission-sequence watermark, not a time. Do not
combine `--cursor` with `--offset` or `--as-of`.

`run analyze` summarizes all matching retained attempts and accepts `--as-of`
to reuse a list watermark. It does not accept pagination flags (`--limit`,
`--offset`, `--cursor`), because the aggregate covers all matching records. It reports measurement/sample coverage alongside durations,
worker-process resources and provider consumption. Missing token or cost evidence
is `null`, not zero. Resource observations belong to the worker process; they do
not establish isolated model CPU or system-wide billing.

JSON export is the default and preserves original run metadata and before/after
snapshots. A queued run has no execution-boundary `before` snapshot until it starts;
`after` remains null until terminal evidence is captured. Recovery/cancellation
measurements are labelled separately. CSV includes ID, session/task identity, kind,
title, provider, model, attempt, sequence, outcome and timing, plus per-attempt
usage, resource deltas and complete before/after JSON in quoted cells. Page metadata
(`schemaVersion`, `total`, `asOf`, `nextOffset`, `nextCursor`) repeats on each row
so CSV consumers can traverse pages with the same cursor contract. Nullable snapshots become empty CSV cells. Formula-like text is escaped for
spreadsheet import. Each export contains one selected page; use JSON with cursor
traversal for a complete matching set. Commands write to stdout and never overwrite
an export file themselves. Explicit shell redirection is your choice.

`provider list` returns only redacted provider configuration. `provider configure
--file PATH|-` is a discoverable alias for the existing provider settings document;
follow it with `provider check --id PROVIDER_ID`. Configuration is not proof of
sign-in, available quota or task completion.

## Feature requests without a browser

Use the same named commands for a human terminal session or AI automation:

```sh
node bin/apps/worker/cli.mjs feature template
node bin/apps/worker/cli.mjs feature create --name request.md --markdown draft.md
node bin/apps/worker/cli.mjs feature get --name request.md
node bin/apps/worker/cli.mjs feature validate --name request.md
node bin/apps/worker/cli.mjs feature submit --name request.md --if-match REVISION
node bin/apps/worker/cli.mjs feature wait --name request.md --timeout-ms 60000
node bin/apps/worker/cli.mjs feature result --name request.md
```

`feature template` prints Markdown and needs no running instance. Save and edit
that draft before creating the watched request. `get` returns the current revision;
`edit --markdown PATH|- --if-match REVISION` safely replaces it while it is still a
draft. `submit` also requires that revision. On a conflict, reread and reconcile;
do not replace another actor's changes. Accepted input is immutable. A successful
`wait` means a stopped or operator-action status was observed, including failure,
cancellation, questions or escalation; inspect the returned status and result before treating it as work
success. A deadline exits 1 with stderr JSON `code: "wait_timeout"` and leaves the
task running. API/input rejection exits 2. Polling requests remain bounded by the
normal HTTP timeout; a slow in-flight request may outlast a short polling deadline.

For failed/cancelled features, inspect `feature result`, then use `feature retry
--name NAME --if-match REVISION` with a freshly read revision. Use `run list
--session-id SESSION_ID` and `run get --id RUN_ID` to compare retained attempts.
Retries and follow-up requests are not idempotent: inspect results after an
uncertain response before repeating them. Queue pause retains waiting work and
lets the current attempt finish; queue resume starts the retained queue.


## Questions, escalations and retained-context continuation

The authenticated `capabilities` command describes the interaction contract and
adapter limitations. The current model adapters use `worker_context_replay`: Werk
retains the transcript and immutable dispatch context and supplies it to a new
provider call. This is not a resumed provider-native CLI thread. Configuration,
a supported adapter or a sign-in check does not establish model access, quota or
successful execution. Native thread/session IDs are not interchangeable with
Werk worker session IDs.

```sh
node bin/apps/worker/cli.mjs capabilities
node bin/apps/worker/cli.mjs interaction get --id SESSION_ID
node bin/apps/worker/cli.mjs interaction turn --id SESSION_ID --turn-id TURN_ID
```

`interaction get` returns `schemaVersion: 1`, `sessionId`, a numeric `revision`,
`phase`, `pending`, `latestTurn`, bounded `turns` and `totalTurns`.
Phases distinguish `idle`, `queued`, `running`, `waiting_input`, `escalated`,
`completed`, `failed`, `cancelled` and `interrupted`. A pending request contains
its own `id`, originating `turnId`, `kind` (`question` or `escalation`), message,
optional choices and optional reason. It is structured model output; a question
mark in an ordinary reply does not create a pending interaction.

Read a turn to inspect its immutable `input`, `context`, actual prepared `dispatch`
and `dispatchDigest`, result, usage and safe error code. These records contain
private task/prompt text and require worker authentication. Provider credentials
are excluded. Empty dispatch/result fields represent work not dispatched or not
yet completed; they do not imply model success.

For durable automation notifications, poll normalized events:

```sh
node bin/apps/worker/cli.mjs interaction events --id SESSION_ID --after 0 --limit 50
```

The response is `{schemaVersion:1,sessionId,events,nextAfter,hasMore}`. `after`
is a nonnegative global event sequence, filtered to this session. Pass `nextAfter`
for the next page or later poll; an empty page retains the incoming sequence.
`limit` is 1–100, default 50. Events have durable IDs, sequence, revision, turn/run
references, timestamp, phase and a normalized type. Accepted, prepared, started,
usage-observed, input-requested, escalation and stopped outcomes remain distinct.
Events omit prompt text and raw provider output. This is durable polling, not
live token streaming or SSE. Use `interaction turn` for the private actual request.

An answer document contains only the plaintext answer:

```json
{"answer":"Use the existing layout and preserve its navigation."}
```

Use the worker session ID, current `pending.id`, actual numeric revision and a
stable operation ID you choose. Replace the placeholders with values read from
`interaction get`; the revision is an integer, distinct from a feature file's
SHA-256 revision.

```sh
node bin/apps/worker/cli.mjs interaction answer --id SESSION_ID --question-id PENDING_ID --if-match NUMERIC_REVISION --key answer-001 --file answer.json
```

For a short non-sensitive answer, `--message "Use the existing layout"` replaces
`--file`. JSON stdin is supported with `--file -`. Supplying both message sources
or embedding target/revision/operation fields in the file is rejected. Messages
must contain 1–8,000 characters. The worker binds the answer to the pending request;
it does not mutate the original accepted feature requirement or silently answer
an unrelated task.

To decline a pending decision without racing another operator's answer, use the
same target/revision guards with a distinct operation ID:

```sh
node bin/apps/worker/cli.mjs interaction cancel --id SESSION_ID --question-id PENDING_ID --if-match NUMERIC_REVISION --key decline-001
```

Pending decisions are separate from running execution. Use the owning task or
file-task cancellation command to interrupt active work. An unanswered question
or escalation is answered or declined; resume targets a failed, cancelled or
interrupted retained turn.

The operation ID makes an uncertain network response recoverable. Repeating the
same command and content with that ID replays its acknowledgement, even when the
interaction has subsequently advanced. Reusing the ID for altered input, or using
a stale revision for a new operation, conflicts (exit 2). On a conflict, reread
and reconcile rather than guessing the next revision. Accepted answers and model
continuation are separate facts: the worker may retain queued work while capacity
is occupied or its queue is paused. Inspect the returned phase and pending state.

To continue a supported stopped interaction, read its retained turn, then resume
with the current revision and a new stable operation ID:

```sh
node bin/apps/worker/cli.mjs interaction resume --id SESSION_ID --turn-id PRIOR_TURN_ID --if-match NUMERIC_REVISION --key resume-001
node bin/apps/worker/cli.mjs task resume --id SESSION_ID --turn-id PRIOR_TURN_ID --if-match NUMERIC_REVISION --key resume-001 --file continuation.json
```

`task resume` is an alias of `interaction resume`. Optional continuation input is
`{"message":"Continue using the saved context."}` or `--message TEXT`; omitting
it requests the worker's explicit default continuation. Resume uses the retained
turn's context under the reported adapter capabilities. Retry remains a separate
operation: Chat retry resends the last user message, and approved-file retry uses
captured original files. Neither is proof of native provider session resume.
Resume cannot grant tools, new filesystem scope, approval, publication or merge.
Ownership restrictions on orchestrator assignments still apply.

`task wait`, `file-task wait` and `feature wait` return when work completes,
fails, is cancelled, becomes unavailable, or requires operator input.
`waiting_input` and `escalated` are actionable states, not `completed`.
After either state, inspect `interaction get` for the pending request and decide
whether to answer, resume an allowed turn, or cancel through the owning task API.
Exit 0 means the requested observation succeeded; inspect the phase/status before
treating work as successful. Timeout still exits 1 with `wait_timeout` and never
cancels work. `run list` and `run analyze` retain waiting/escalated attempts as
separate outcomes rather than folding them into successful completion.
