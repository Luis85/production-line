# Portable Node applications

The runtime release contains `bin/apps/factory`, `bin/apps/orchestrator` and
`bin/apps/worker`. Copy any complete folder into another project's `bin/apps/`.
Each includes its compiled application, webview, CLI and runtime dependencies.
Only **Node.js 24.x** is required. No npm install, source checkout, Docker or sibling
application is needed. CLI subscription providers additionally need their installed,
authenticated executable on the worker machine. Claude Code and Cursor CLIs run
on Linux, macOS and Windows; Codex CLI requires Linux or macOS. API providers need a configured key and selected model.

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
from the result. Workers open Taskboard first; Factory and orchestrators open Dashboard.
Startup returns the private credential **file path**, never its contents. Open the
returned URL and unlock the webview using that file locally. The CLI reads local
credentials itself. Workers may enroll later through `settings set`; Factory can
register an already running orchestrator as a line.

## Project environment and local access

Run `node bin/apps/worker/cli.mjs env init --project-dir /absolute/project`
to create that app's private project `.env` and credential-free `.env.example`.
Factory and orchestrator expose the same command. When adopting existing state,
pass its `--state-dir /absolute/state` so setup reuses its credentials. Project
worker `init` performs this step automatically. Existing values/comments are
preserved; missing keys are appended and the private file is ignored by Git.
Initialization prints paths and key names only.

The worker's local unlock token is `WERK_WORKER_TOKEN` in the private project
file; runtime also maintains `<worker-state>/webview-token`. Its host, port, state,
config and optional upstream use `WERK_WORKER_*` keys. Factory uses
`WERK_FACTORY_*`; orchestrator launch defaults use `WERK_ORCHESTRATOR_*` with
`WERK_ADMIN_TOKEN`/`WERK_ENROLLMENT_TOKEN`. Consult
[project environment configuration](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/configuration.md#project-environment-files)
for the complete list and saved worker-settings exceptions.

Explicit CLI options override environment launch defaults; process environment
overrides project `.env`. Relative environment state/config paths resolve in the
project directory. Stop before intentionally changing a local access token, then
restart to synchronize private state. Removing an environment value preserves
the saved token. A malformed project file does not block `status`/`stop` when
you provide an explicit state directory. Explicit remote `--url` commands still
need `--token-file` or process `WERK_APP_TOKEN`; local dotenv secrets are not sent
to that URL. No npm install or dotenv package is required.

## Initialize a project worker

Run the release worker's `cli.mjs init --project-dir /absolute/project` to install
the app into that project's `bin/apps/worker`, create `.env`/`.env.example`,
`.werk/worker.json`, a draft
feature-request template and `.werk/compose.worker.yaml`. Use `--features-dir` to
choose a project-relative folder and `--provider` to choose its default connection.
`--workflow-dir DIR` places the Feature Requests Base, reviews, tasks and check files
under `DIR` (see [keep the project root tidy](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/project-worker.md#keep-the-project-root-tidy));
`--no-npm` skips the root `package.json` and reports `npm: { skipped: true }`.
`--intake shared|local` (default `shared`) chooses the request source. `local` is for an operator-only
worker: it writes `<features-dir>/_templates/local-request.md` (no `templateId`, `status: draft`,
`mode: patch`, your provider, commented `paths` and `definitionRef`), records `features.intake: "local"` in
`.werk/worker.json`, and reports `intake: { mode: "local", connectionRequired: false, template, commands, next }`
instead of `shared_git`. Such a worker's detected checkout is accepted with `watch: false` unless
`repository accept --watch true` says otherwise, and `shared status` and `feature list` add
`intake: "local"` and a `hint` until a shared repository binding is saved. That binding
takes precedence over the local preset, even when paused; existing repository watch
settings remain unchanged. Repeated `init` preserves the recorded preset and refuses
a conflicting explicit choice. See
[operator-only setup](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/project-worker.md#set-up-an-operator-only-worker).
Run or start from the project directory; the installed worker discovers its project
configuration. `feature template` prints a fresh Markdown template without a running
worker; `feature list` reads the authenticated watcher state. Template output is
Markdown, an intentional exception to JSON CLI output.

See the [project worker guide](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/project-worker.md)
and [feature request contract](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/feature-requests.md).
Each watched folder belongs to one worker state; choose separate feature folders,
state directories and ports for additional workers.

## Assign repositories to a worker

If the installation/project folder is a Git root, the worker offers it on
Taskboard before using it. Review `repository status`, then explicitly choose
`repository accept --discovery-id ID` or `repository decline --discovery-id ID`.
The saved choice survives restart; acceptance adds an assignment. No remote or
detached HEAD leaves watching off. Discovery never selects an unrelated ancestor.

Use **Settings → Repositories** or
`settings set --file repositories.json` with a top-level
`repositories` object: `{pollMs: 30000, items: [{id, path, remote, branch?, watch}]}`.
Assign existing local Git checkouts; the worker watches/fetches each enabled
repository and only fast-forwards clean bases. Coding tasks use retained worktrees
under each checkout's `.werk/worktrees`, or under the optional absolute
`repositories.worktreeDirectory` outside every checkout so project tools do not
scan task copies. Drain tasks before changing assignments.
Worker JSON passed through `--config` can seed assignments; saved private settings
take precedence after the first start. Git must be installed on the worker host.

Use `repository status` to inspect assignments and `repository sync --id app`
to check/pull one assignment; omit `--id` for all. `worktrees list` shows the task
worktrees this worker created, their state and the file task still using each.
`worktrees prune --dry-run` previews and `worktrees prune [--id NAME]` removes
clean ones no file task uses; add `--discard-changes true` to also remove changed
or interrupted ones. Worktrees with commits, locks, symbolic links or junctions
are always kept for manual review. The same private endpoint is
available with `api --path /api/repositories`. Local file tasks select the assignment ID
in their existing `repository` field. Assigning repositories does not change
mock execution or give provider Chat arbitrary filesystem tools. See the
[configuration contract](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/configuration.md#assigned-git-repositories).

Execution profiles are editable in **Settings → Execution profiles** or through
`profile list` / `profile set --file profiles.json`. Keep the current mode and
one shared execution slot. Pause and drain work first; registered workers persist
changes until their orchestrator acknowledges them. See the
[CLI contract](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/runtime-cli.md#worker-repositories-and-execution-profiles)
for guarded input and pending-update behavior.

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
over saved private settings and must be removed/restarted before duration edits.
Tool budgets remain editable: `execution.maxToolCalls` defaults to 128 (1–512),
and `execution.commandTimeoutMs` to 300000 (1000–3600000). The total duration
still bounds each command. Settings → Queue & duration exposes these controls;
API/CLI saves can include the complete `expectedToolBudget` pair to reject stale
changes. Each invocation retains the budgets captured when it was prepared.
Worker help also lists the verified-implementation source limits
`execution.candidateSourceMaxBytes`, `candidateSourceMaxFiles` and
`candidateFileMaxBytes` with their defaults and ranges. Change them in **Settings →
Queue & duration → Repository inspection limits**, or use `settings set` with an
`execution` body. CLI/API sizes are whole bytes; the webview displays MiB. Include
the complete `expectedCandidateInspection` baseline from `settings get` to reject
concurrent edits. These bounds affect source inspection, not approved edit scope.
Approved candidate content for implementation requests has three further settings:
`execution.candidateApprovedFileMaxBytes` (default 24000, 1000–8388608),
`candidateApprovedTotalMaxBytes` (default 48000, 1000–67108864, at least the
per-file limit) and `candidateReviewPatchMaxBytes` (default 120000,
10000–4194304). `settings get` shows them; change them with `settings set` and an
`execution` body, including the complete `expectedCandidateReview` baseline (all
three current values) to reject concurrent edits. Each implementation dispatch
freezes them; raising them never widens the approved paths. See
[execution settings](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/configuration.md#local-worker-execution-policy).
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
policy while stopped. To update, use the guarded [update command](#update-a-copied-app).
Copying runtime files never copies provider credentials or task history. Stop all
writers before backing up.

## Update a copied app

A copied app folder from 0.9.0 onward replaces itself with a verified release.
Run update commands from the project directory, never from inside the app folder:

```sh
node bin/apps/worker/cli.mjs update check
node bin/apps/worker/cli.mjs update apply --stop
node bin/apps/worker/cli.mjs update status
node bin/apps/worker/cli.mjs update rollback --stop
```

`check` reads the stable `SHA256SUMS` from GitHub and reports `current`, `target`
and `available` without changing files. `--version X.Y.Z` selects that release's
own checksum file instead of the latest. `apply` downloads the pinned archive into
a temporary directory outside the project, checks its SHA-256 against `SHA256SUMS`,
extracts it and verifies the complete release inventory, exactly like `install.mjs`.
The release must declare update protocol 1 and state format 1, and must be newer:
an older `--version` is refused (use `rollback`). Without network access, extract a
release you verified yourself and pass `--from /path/werk-X.Y.Z`; its own release
manifest is verified. The same route works when extraction is too slow on your
machine: extract the archive yourself, then apply with `--from`.

Before anything changes, `apply` copies the release's `bin/apps/<app>` into a
staging folder beside the app, verifies every staged file against the release
manifest and runs the staged CLI once. Then it:

1. refuses while the selected instance runs, unless `--stop` was given; `--stop`
   uses the normal graceful `stop`, which drains or cancels running work, so pause
   the queue and let work finish first;
2. holds the instance's application lock so it cannot start during the update;
3. copies the complete state directory into a new, checksum-verified backup at
   `<state>.updates/backups/<UTC timestamp>-<previous version>` (skipped for a
   state directory without files);
4. renames the current folder to `bin/apps/.<app>-update/<version>-<timestamp>`
   and the staged folder into place. Both renames stay on one volume; if the second
   fails, the previous folder is moved back;
5. restarts the instance only if this command stopped it. A `start`ed instance is
   restarted with its recorded working directory and resolved non-secret options,
   including options supplied through the environment. The selected state directory
   stays pinned during restart. Instances started by
   0.8 or earlier recorded none: they restart with the state directory, project
   defaults and previous port. A foreground `run` is left for its terminal or
   service manager. `--no-restart` skips the restart.

If another process holds the app folder open and must keep running, so the folder
cannot be renamed (the `Could not move` error described below), pass
`--in-place` explicitly. It is never chosen automatically:

```sh
node bin/apps/worker/cli.mjs update apply --stop --in-place
```

`--in-place` first ships in 0.14.0. An installed 0.13.x or earlier launcher cannot
use that flag for its first upgrade: stop the process holding the directory and
use the normal update, or stop the app and replace its complete app folder from a
verified release while preserving external state. Once 0.14.0 is installed, future
updates and rollbacks support `--in-place`. Running a newer release's launcher with
`--project-dir` does not target an older app folder; that option selects the project,
and an update replaces the app containing the invoked launcher.

Release verification, staging, the preflight, `--stop`, the state lock, the state
backup and the history record are the same. Step 4 changes: the updater copies the
current folder to `bin/apps/.<app>-update/<version>-<timestamp>` and verifies the
copy, then writes changed and added files from the verified staged release into the
app folder, deletes files the release manifest does not list and removes directories
that become empty. A directory that cannot be removed because a process holds it
open is left empty and listed in `inPlace.emptyDirectoriesLeft`; this is not an
error. Finally every file in the app folder is compared with the release manifest,
byte for byte, and extra or missing files fail the update. For failures caught by
the updater, it attempts to write the retained copy back and verify it. A successful
restore removes that redundant copy, reports that the previous files were restored
and restarts the previous version as below. If restoration also fails, the app stays
stopped and the error names the retained copy for manual recovery. `package.json`
and `cli.mjs` are written last when upgrading and first when downgrading, but this
ordering does not make the update atomic.

A forced termination, host shutdown or power loss can interrupt a file write or
leave a mixture of versions. The installed launcher and update command may no
longer load; rerunning `update apply` is not a guaranteed repair. Keep the app
stopped and preserve its state and all update folders. After verifying the updater
and every process using the app have exited, restore the complete previous app
from the retained folder under `bin/apps/.<app>-update/`: replace the app folder
with that copy, or copy its files back and remove app files absent from the retained
copy. Do not merge it over the interrupted tree without removing extra files. If
termination occurred while creating the retained copy, that copy may be incomplete;
use a separately downloaded and verified release of the previous version instead.
Only after restoring a complete app, remove the stale `update.lock` and application
maintenance lock if their owning processes have exited, then inspect status and
start the app with its original state directory. No history entry is guaranteed
for an interrupted operation, so `update rollback` may still refer to an earlier
update. Keep the retained folder until the restored app has been checked.

The result reports
`method: "in-place"` (otherwise `"swap"`) and `inPlace` with `written`, `removed`
and `emptyDirectoriesLeft` (otherwise `null`); the history entry records
`method: "in-place"`.
Files you added inside the app folder are removed by an in-place update and kept in
the retained copy. A Docker Compose worker that mounts the folder still needs to be
stopped and recreated.

The JSON result names the new version, the retained folder, the backup and the
restart outcome. A failed restart exits 1 after a successful replacement; start the
app manually. If an update fails after stopping the app and its original folder is
intact or restored, the updater attempts to restart that version unless
`--no-restart` was given. If automatic folder recovery fails or another instance
owns the state lock, it reports recovery instructions without attempting another start.
Progress records go to stderr.

The state directory is never modified, and project files, `.env`, feature folders
and agent integrations are not written. Review `integrations plan` after updating
for new templates. For a worker, also run `feature setup`. It refreshes an
unmodified `.werk/authoring/feature-request.mjs` recorded in
`.werk/authoring/manifest.json`. It reports `authoring_script_outdated` with a
`revision` for a changed or unrecorded script, which `feature setup --if-match REVISION`
replaces; see
[Refresh the authoring script after an upgrade](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/team-feature-authoring.md#refresh-the-authoring-script-after-an-upgrade).
`bin/apps/.<app>-update/` and `<state>.updates/` contain a
`.gitignore` that excludes them from Git; backups contain credentials, so keep
them private. Retained folders and backups are not deleted automatically; remove
old ones after the new version is confirmed. Files you added inside the app folder
remain in the retained folder only.

`rollback` swaps back the folder retained by the last update or rollback, so a
second rollback returns to the newer version. `update rollback --stop --in-place`
restores the same retained folder by the in-place method instead: it retains a
verified copy of the current files, copies the retained files back into the app
folder, verifies them and keeps the retained folder it copied from. Rollback never
changes state. If the newer version already changed state, stop the app, restore
the update's backup into a new directory and start with that state:

```sh
node bin/apps/worker/cli.mjs update restore --from .werk/worker.updates/backups/BACKUP --to .werk/worker-restored
node bin/apps/worker/cli.mjs start --state-dir .werk/worker-restored
```

`update status` lists the installed version, running state, retained folders and
last operation. Explicit `--state-dir` and `--project-dir` select the instance as for
`status`. Only one update per app folder runs at a time
(`bin/apps/.<app>-update/update.lock`); after a crash, verify that process exited
before removing that lock.

The command checks one instance. Stop every other instance that runs from the same
app folder (for example a second worker state, or the Docker Compose worker, which
mounts the folder read-only) before updating, then recreate the container. On
Windows, a terminal, editor, indexer or antivirus scan holding a file in the app
folder blocks the rename; the update retries for ten seconds and then fails without
replacing anything. Use the direct `node bin/apps/worker/cli.mjs update ...`
commands above on Windows; an npm parent process can keep the app folder open.

If the update fails with
`Could not move ... Another process holds a file or directory open inside it`,
something holds a handle inside the app folder, typically a long-running process
started from the project folder. Windows Restart Manager does not report directory
handles, so the tools that list locked files can show nothing. Look for
long-running processes whose working directory is the project: agent MCP servers,
language servers and file watchers started from the project folder. Stop them and
run the update again. Nothing was replaced; if the update stopped the app, it
restarts the previous version and reports whether that worked. If you cannot stop
that process, for example the MCP servers of agent sessions you keep open, run
`update apply --stop --in-place` (or `update rollback --stop --in-place`), as the
error suggests. It replaces the files inside the folder, verifies them against the
release manifest and reports directories it had to leave empty.

Downloads and extraction use the system temporary directory to keep paths short.

Version 0.8.0 and earlier have no `update` command. Upgrade those once by hand: stop,
back up the state directory, replace the complete app folder with a verified 0.9.0
or later copy, then start with the same state and launch options.

## Give a worker tasks from an AI agent or CI

Configure a provider using `settings set --file provider.json`; files and stdin
contain JSON and are limited to 64 KiB. Subscription login takes place with the
provider's CLI on the host. An example settings document is:

```json
{"provider":{"id":"codex-cli","executable":"/absolute/path/to/codex"}}
```

On Windows, configure Claude Code CLI with its absolute `claude.exe` path and use
`"provider":"claude-cli"` in task input, or configure Cursor's `agent.exe` with
`"provider":"cursor-cli"`. See the
[Windows CLI requirements](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/use-worker-webview.md#connect-claude-codex-or-cursor)
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
Provider work shares the machine execution ceiling, defaulting to one slot.
Approved project delivery can use configured parallel slots within its project
limit; unscoped Chat, legacy work and remote assignments remain exclusive. Queue
places add waiting capacity and never bypass execution ownership.

Every task also receives an automatically synchronized Markdown feature-request
record. Follow-ups, checkpoints and retries retain that session's record. Source
intake files and private execution journals remain authoritative; a pending/failed
Markdown sync does not reject an already accepted task. See
[automatic task tracking](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/feature-requests.md#automatic-task-tracking).

The webview uses one request composer with optional repository-file permission.
The compatible CLI keeps `file-task create --file file-task.json` for the bounded
approved-file execution contract. Supply an explicit repository and paths:

```json
{"title":"Explain the acceptance rule","instruction":"Add a comment explaining the rule.","provider":"codex-cli","repository":"/absolute/project","paths":["acceptance.txt"]}
```

Add `"background": true` to return a preparation receipt immediately. This is
in-memory progress; a task is durably accepted only after preparation finishes.
The task appears once its Git worktree is ready, and `file-task list` shows it
under `preparations` meanwhile, or with its failure reason. Retain the submitted
input and inspect current state before retrying an ambiguous creation. Stop a
preparation with `file-task cancel --id ID`; dismiss a failed entry with
`file-task delete --id ID`. These compatible CLI commands use the legacy
taskboard API. The unified webview uses `POST /api/tasks` with a caller-retained
request ID; see [background preparation](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/feature-requests.md#automatic-task-tracking).

Use background preparation with large repositories, where checkout can outlast
the CLI request timeout. Inspect `file-task list`, `file-task get --id ID`, or
use `file-task action --file` for taskboard operations. Eligible new Git-backed
requests edit approved paths in their retained worktree and run required checks;
other requests retain the proposal-only workflow. Both produce a review patch
and leave the developer checkout separate. See [implement a feature](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/implement-feature.md).
`session action --file` supports rename/archive/delete with the same restrictions
as the webview. `settings set` configures the local queue, provider connections
and optional orchestrator:

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
Cursor uses the worker OS account's `agent login` or a private API key; see
[Cursor setup](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/use-worker-webview.md#connect-cursor-cli)
for native permissions, model selection and unavailable usage counters.

```sh
node bin/apps/worker/cli.mjs provider check --id codex-cli
node bin/apps/worker/cli.mjs definition preview --file .werk/agents/project-reviewer.yaml
node bin/apps/worker/cli.mjs definition import --file .werk/agents/project-reviewer.yaml --name "Project reviewer" --ref project-reviewer
node bin/apps/worker/cli.mjs definition list
node bin/apps/worker/cli.mjs definition ref --id DEFINITION_ID --ref project-reviewer
node bin/apps/worker/cli.mjs definition update --ref project-reviewer --file .werk/agents/project-reviewer.yaml --dry-run
node bin/apps/worker/cli.mjs definition update --ref project-reviewer --file .werk/agents/project-reviewer.yaml --if-match REVISION
node bin/apps/worker/cli.mjs definition delete --id DEFINITION_ID
```

A `--file` ending in `.yaml` or `.yml` (any case) is sent as the YAML profile
itself, so the committed file needs no wrapper; `--file -` and other extensions
stay JSON. JSON preview input is `{"yaml":"YAML_TEXT"}`; JSON import adds
`"name":"Project reviewer"` and optionally a stable `"ref":"project-reviewer"`.
`--name NAME` (import and update) sets the name for YAML and JSON input alike and
is required when importing a YAML file; give the name either as `--name` or in
the JSON, not both. `--ref REF` on import sets the stable reference in the same
step (as `--ref` or JSON `"ref"`, not both); a reference another definition holds
is refused with exit 2, and `definition ref` moves it instead. `definition update` replaces the profile behind a reference in
place: its ID and reference stay, and without a name the stored name is kept. `--dry-run` writes nothing and returns the current `revision`, the
name and digest change, and added, removed and changed agents. Apply with
`--if-match` set to the `revision` from the dry run or `definition list`; a changed
profile is refused with exit 2. Existing tasks keep the snapshot they accepted.
The returned definition ID can be added to `task create` or `file-task create`
input as `"definitionId":"DEFINITION_ID","agent":"root"`. Shared or committed
input should use `"definitionRef":"project-reviewer"` instead, which resolves on
whichever worker receives it. The task stores an
immutable instruction/model snapshot. Supported OpenAI/Anthropic model references
require a matching worker provider; the definition never silently changes billing.

This is an instruction-profile integration. Preview lists unsupported Docker
runtime features, and preview, import and update responses add a `warnings`
array naming each agent that needs adaptation and its unsupported items. Only
after reviewing them, add `"useInstructionsOnly":true` to explicitly omit them
for the task. `feature validate` and local folder intake report a request that
selects such a profile without it, or an unknown `definitionRef`, before the
request is reserved. Tools, hooks, harnesses, sub-agents, remote
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
| `file-task delete` | Also removes the task's Git worktree when clean, otherwise keeps it and reports why. `--remove-worktree false` keeps it; `true` fails unless removed. `--discard-changes true` removes uncommitted/untracked files too. |
| `worktrees list` | Task worktrees of assigned repositories: name, location, state and the file task using each. |
| `worktrees prune` | Optional `--id NAME`, `--repository ID`, `--discard-changes true`, `--dry-run`; removes worktrees no file task uses. Requires no queued or running work, except with `--dry-run`. |
| `file-task priority` | `--id TASK_ID --priority 1\|2`; queued tasks only. |
| `task wait`, `file-task wait` | `--id ID [--timeout-ms N]`; stopped/action-required polling, default 60 seconds, maximum 24 hours. Inspect status to distinguish success, failure, cancellation or pending input; timeout exits 1 without cancelling. |
| `queue get`, `queue settings` | Executor/session state or redacted configuration. |
| `queue pause`, `queue resume` | Pause/resume execution and new orchestrator claims. Running work finishes; queued work is retained. |
| `queue configure` | `--file PATH\|-`; e.g. `{"board":{"queueCapacity":16,"orchestratorQueue":4,"order":"fifo"}}`. |

Local admission capacity is 1–64; the orchestrator waiting buffer is 0–64.
The machine ceiling is `board.maxParallel` (1–8, default 1), further limited by
the approved project's `coordination.maxActiveRequests`. Unscoped legacy work
remains exclusive. Setting the remote buffer to zero disables extra remote
queuing; pausing preserves accepted work. Unknown provider attempts reserve
capacity across restart until explicitly reconciled.
Existing `session action`, `file-task action`, settings, provider checks, agent
definitions, environment, monitoring and history remain available. Feature-file
management is documented in the [feature-request reference](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reference/feature-requests.md#cli-management-contract).

Input/API rejection exits 2; operational failure exits 1. CLI commands never
prompt. A successful `wait` means a stopped or operator-action state was observed.
Callers must inspect status and pending input before treating output as work success.


## Recover an uncertain provider attempt

Ready Check, advisory-review and older provider attempts may retain an unknown
outcome without a delivery-owned recovery command. Inspect them through the
authenticated requests API. Save `{"action":"execution_recovery"}` in
`inspect-recovery.json`, then run:

```sh
node bin/apps/worker/cli.mjs api --path /api/requests --method POST --file inspect-recovery.json
```

After inspecting the host and stopping any surviving processes and development
services, create `confirm-stop.json` using the returned run ID and its
`executionRecovery.revision` (not a Feature Request revision):

```json
{
  "action": "confirm_execution_stopped",
  "runId": "00000000-0000-4000-8000-000000000000",
  "expectedRevision": 1,
  "operationId": "inspected-stop-001",
  "note": "I inspected the host and stopped this attempt's remaining processes."
}
```

Replace the example identity and revision with the inspected values. The note
must be nonempty and at most 4,000 characters; the operation ID allows letters,
digits, underscores and hyphens, up to 100 characters. Submit it with:

```sh
node bin/apps/worker/cli.mjs api --path /api/requests --method POST --file confirm-stop.json
```

The worker checks the exact recovery revision and refuses a live controller,
owned process or managed service, including ownership by a parent attempt.
After an uncertain acknowledgement, repeat the identical payload and operation
ID; changing its content conflicts. This is an operator attestation that releases
the reservation, not evidence of model completion or recovered billing. Retry
the Ready Check or continue the request through its normal action separately.
An abort before provider dispatch makes no call; aborting an already dispatched
API request retains an unknown outcome because the remote operation may continue.
Delivery-owned work uses its existing exact-run recovery controls instead.

## Worker consumption limits

| Command | Contract |
| --- | --- |
| `consumption status` | Authenticated `GET /api/consumption`; current policy, UTC window, measured/reserved/remaining tokens and the reason new model calls are blocked. Makes no model request. |
| `consumption configure --file PATH\|-` | `POST /api/settings`; save the complete policy under its `consumption` wrapper. |

Example configuration, allocating half of a configured daily allowance:

```json
{"consumption":{"enabled":true,"period":"daily","allowance":1000000,"workerPercent":50,"perRunReservation":10000}}
```

Use `--state-dir` to select the same worker state as startup. Limits start disabled;
usage starts with consumption accounting and is not backfilled. The period is `daily` or `monthly`
using UTC calendar boundaries. The whole-token allowance must be positive, the
worker percentage is 1–100, and the positive per-run reservation cannot exceed
the worker's allocation. An optional `expectedConsumption` sibling contains the
policy last read; a stale baseline conflicts instead of overwriting newer settings.

Accepted work remains queued until enough budget is available. Eligible queued
work resumes after the period reset or a policy change; a manually paused queue
stays paused. Unknown final usage blocks new model calls while enforcement is
on. An active response can exceed its reservation before reporting usage.
This is one worker's configured token budget; personal use outside Werk and
provider subscription balances are not measured. See
[consumption configuration and recovery](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/worker-consumption-limits.md)
for the webview, accounting fields and failure behavior.

## Worker model tool access

| Command | Contract |
| --- | --- |
| `tool-access get` | Authenticated `GET /api/tool-access`; current grants, revision, edit state and the worker's Node.js executable. MCP secrets are redacted. |
| `tool-access set --file PATH\|-` | `POST /api/tool-access`; replace all grants while new starts are paused and the worker is idle. Accepts the edited `tool-access get` output (its `revision` becomes the guard) or `expectedRevision`, `builtins` and `mcp`. Omitted MCP connections and CLI tools are removed. |
| `tool-access discover --id ID --if-match REVISION` | `POST /api/tool-access/discover`; read a saved MCP connection's catalog without granting tools. |

`tool-access set` accepts exported JSON up to 1 MiB from a file or stdin. It removes
known read-only fields (including discovered catalogs) before sending the write,
which must still fit the API's 64 KiB limit. Other JSON commands remain limited
to 64 KiB.

An enabled fixed command preset with `verification: true` is a required feature
check. Together with file access and an approved Git worktree, it enables candidate
editing and checked implementation for new requests. The final patch reflects
actual retained-worktree changes; old proposal tasks remain proposals. See
[implement a feature](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/implement-feature.md).

CLI tools require an approved task worktree and a saved operator grant. They let
the model pass its own arguments to a project command, such as a Node script in
`bin/`, within allowed commands, required flags and refused options. Configure
them in **Settings → Tools & MCP** or with these commands. Discovery applies to
MCP connections; it does not grant a CLI or MCP tool.

Before rolling back to 0.9.0, use the current version to remove all CLI tool
entries, clear verification marks and save tool access. Reset tool budgets to
128 calls and 300000 milliseconds and save settings. Disabling entries alone
does not remove the newer policy fields. Restore the pre-upgrade state backup
when retained tasks are incompatible. See
[give the model a project CLI](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/manage-model-tools.md#give-the-model-a-project-cli).

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
success. A deadline exits 1 with stderr JSON `code: "wait_timeout"`; the CLI sends
no cancellation request. A lost status connection cannot establish whether work
is still running. Inspect `status` and the request's current result before deciding
to continue or cancel. API/input rejection exits 2.

`--timeout-ms` bounds the complete wait; `--request-timeout-ms` bounds each status
read. Each read uses the smaller of the configured request timeout and the remaining
wait, and no new poll starts after the wait deadline. Client request timeouts and
transient connection failures are retried within that deadline; API/input errors
end the wait immediately. Timeout diagnostics count failed polls. These polling
limits do not change the worker's captured model-invocation budget.

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
