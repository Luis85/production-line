# Runtime operator CLI

All commands below run from an extracted release root. They manage the packaged
runtime; they do not build source. Simulation is the default. The optional native
Linux [Codex policy](../how-to/run-codex-task.md) launches the configured provider
for explicitly opted-in trusted tasks.

The [system operator](system-definition.md#operator-actions) starts a complete
Factory hierarchy from one YAML file. `node werk.mjs up` sets up and starts the complete example system in one command; `--file PATH` selects your own YAML. Its state belongs to `.werk-system/`, and it stops with Ctrl+C or `node werk.mjs system stop --file examples/system.yaml`. The commands below describe the separate
single-line operator and its `.werk` state.

## Native operator

Entry point: `node werk.mjs`. Requires Node 24.x.

| Action | Contract |
| --- | --- |
| `setup` | Create configuration and distinct credentials; preserve valid existing setup |
| `start` | Run the orchestrator and workers in the foreground; wait for readiness, then optionally open the browser |
| `status` | Inspect the selected runtime state |
| `doctor` | Check runtime readiness and report unhealthy components |
| `stop` | Request ordered shutdown through authenticated local supervisor control |
| `open` | Open a token-free loopback application URL; authentication remains in the login form |

`--state-dir PATH` selects persistent state and is available for every action.
Default: `.werk` beside the release launcher. Setup accepts `--project`, `--port`,
`--worker-port`, `--workers`, and `--runtime native|docker`; native is the default.
Worker count is 1–8 for native execution. Ports are integers 1–65535; the
orchestrator and contiguous worker-status ports must not overlap. Start accepts
`--no-open` and `--log-output file|stream|both`; `--json` also suppresses automatic
browser opening. Environment defaults and CLI precedence are defined in
[configuration](configuration.md).

With `--json`, setup/status/doctor/stop/open return one JSON object. Successful
results have `ok: true`. Command/configuration exceptions return `ok: false` and
`error: {code, message}`. Doctor returns `{ok, state, checks, next}`: an unhealthy
check sets `ok: false` and describes the failure inside `checks`, rather than
requiring an error envelope. Start instead
emits JSON lines for lifecycle events including `starting`, `ready`, `stopping`
and `stopped`. It is a long-running foreground process, not a detached success
response. Sanitized `service_log` records carry an allowlisted nested `entry`;
raw child stderr and credentials are not relayed. In `stream`/`both` mode human
output also includes service-log JSON records, so use `--json` for consistent
machine framing. The [observability reference](observability.md) defines fields.

Exit 0 means success, 2 means a rejected command/configuration, and 1 means an
operational failure or unhealthy doctor result. Doctor captures setup/configuration
failures as failed checks and exits 1. A stopped runtime can pass doctor when its
artifacts, configuration and available ports are ready for a subsequent start. Human
output is for operators; agents should request JSON and inspect both the exit
status and result. Do not match an error by message text alone.

## Docker operator

Entry points: `bash werk-docker.sh` or `./werk-docker.ps1`. Requires Docker with
Compose and the corresponding shell, but no host Node/npm. Use Docker Engine
26+ and Compose 2.35+; the Windows worker mount requires named-volume subpath
support supplied by these versions/current Docker Desktop.

Actions: `setup`, `start`, `status`, `logs`, `stop`, and `cli` followed by
orchestrator CLI arguments. Use `--state-dir PATH` consistently; use `--no-open`
for headless start and `--json` for supported structured operator results.
PowerShell additionally supports `credentials`: explicitly export the private
credential file into a new host `credential-export` directory, returning
`{credentialsFile, credentialsPrinted: false}`. It refuses an existing destination.
Windows uses a named volume and requires the host pointer to match its ownership
label. Bash uses a private host bind directory. See [configuration](configuration.md).

Docker currently supports one worker and rejects a native-mode configuration or
a worker count it cannot run. Setup and start do not silently change runtime mode.

Docker output is not the native operator envelope: status/start return a
`{mode, execution, ready, url, orchestrator, worker}` result, stop returns
`{stopped, statePreserved}`, and `logs --json` returns `{lines}`. Diagnose Docker
and wrapper errors through their nonzero exit and stderr; do not require an
`ok` field or a structured error envelope. Docker start is detached and returns
after readiness, unlike native start's foreground JSON-line stream.

`cli` preserves the application's JSON/stdin interface; for example
`cli task create --file - --key submission-001` reads a task JSON object from
stdin. The task JSON accepts optional `repository` as the worker assignment ID;
`project` remains the line scope. Without `repository`, native Codex falls back to
the assignment matching `project`. Native application note intake also accepts
`task create --project ID --wikilink "[[Feature]]" --repository ASSIGNMENT_ID --key KEY`.
With `--file`, place `repository` in the JSON instead of combining both forms.
Application-client exit codes and output belong to that invoked client.

## Application clients

The packaged clients remain independently usable:

```text
node src/factory/dist/factory/cli.js --help
node src/orchestrator/dist/orchestrator/cli.js --help
node src/worker/dist/worker/cli.js --help
```

Each complete `dist` tree contains its runtime dependencies. Factory hierarchy
management is optional and is not started by the single-line operator. See
[configuration](configuration.md) for credential scopes and
[agent operation](../how-to/operate-with-agents.md) for safe noninteractive use.

## Worker repositories and execution profiles

Use the portable worker client from the installed project with the same
`--state-dir` as startup when overriding its default. It reads the selected
worker’s local credentials; stdout is JSON and no command prompts for a choice.

| Command after `node bin/apps/worker/cli.mjs` | Contract |
| --- | --- |
| `repository status` | Inspect assignments and the detected project checkout without fetching |
| `repository sync [--id ASSIGNMENT_ID]` | Fetch and safely fast-forward one assignment, or all when omitted; waits up to 120 s |
| `repository accept --discovery-id ID [--watch true|false]` | Accept the exact detected checkout and save an assignment; requires idle work. `--watch` sets background fetching for the new assignment; default `false` when `features.intake` is `local`, otherwise `true` for a checkout with a remote and branch. `true` without a remote is refused |
| `repository decline --discovery-id ID` | Persist the choice not to use the detected checkout |
| `worktrees list` | List task worktrees in assigned repositories with location, state and using file task |
| `worktrees prune [--id NAME] [--repository ID] [--discard-changes true] [--dry-run]` | Remove worktrees no file task uses; clean only unless `--discard-changes true`; requires idle work except for `--dry-run` |
| `footprint` | Read-only inventory of the installed worker by group (`app`, `retained`, `state`, `configuration`, `authoring`, `requests`, `integrations`, `environment`, `worktrees`) with path, existence, size and Git tracking; works running or stopped; no file contents or credentials |
| `uninstall --dry-run \| --confirm [--stop] [--include-requests] [--include-environment]` | Run from the project directory. `--dry-run` lists `remove` and `keep` with reasons; `--confirm` needs a stopped worker (or `--stop`), removes owned clean task worktrees, then untracked integration, authoring, configuration, state, retained and app files, the app last. Tracked files, edited files, request folders and `.env` entries stay unless included. Exit 1 with `ok: false` when something could not be removed. See [Remove a project worker](../how-to/project-worker.md#remove-a-project-worker) |
| `shared status` | Inspect shared Git intake: binding, `revision`, workflow snapshot and requests, without fetching |
| `shared sync` | Fetch the shared branch now and reconcile claims and publications; waits up to 120 s |
| `shared configure --file intake.json` | Save `{"expectedRevision":N,"config":{...}}` while new starts are paused and idle. `config` must be complete: `enabled`, `repositoryId`, `remote`, `branch`, `workflowPath` and `pollMs` |
| `profile list` | Read active profiles, current `configurationHash` and any pending update |
| `profile set --file profiles.json` | Save a guarded profile update while paused and idle; `--file -` reads stdin |

JSON input from `--file PATH` or `--file -` may start with a UTF-8 byte order mark,
which Windows PowerShell 5.1 adds to piped input. Each API call waits 30 s, or
120 s for the Git operations marked above and for `settings set`; `--request-timeout-ms 1000–600000`
overrides the wait. A timeout (`"code":"timeout"`, exit 1) only means the client
stopped waiting: run `shared status` or `repository status` before retrying.

Prune never removes a worktree with commits on its detached HEAD, an operator
lock, or a symbolic link or junction inside; review those manually. Results list
`removed`, `would_remove` or `kept` with a reason for each worktree.

Read `repository status` first and use its `discovery.id`, not an assignment ID
or path, for accept/decline. Both choices survive restart; a declined candidate
can later be accepted. Acceptance starts watching only when a branch and remote
exist. No remote or detached HEAD leaves watching off; committed tasks can still
use worktrees. A stale discovery ID requires inspecting the current candidate.

For profile changes, drain queued/running work and active replies, run
`queue pause`, then `profile list`. Use its active `configurationHash` in the
input below, preserving the worker’s current mode:

```json
{
  "expectedConfigurationHash": "HASH_FROM_PROFILE_LIST",
  "profiles": [{ "id": "codex-review", "provider": "codex", "mode": "mock", "maxParallel": 1 }]
}
```

Mock mode supports 1–8 unique Claude/Codex profiles. Native Linux Codex mode
supports exactly one Codex profile with `mode: "cli"`; the editor cannot switch
modes or add execution slots. Before first registration the save applies locally.
For a registered worker, a successful save may return `state: "pending"` while
the orchestrator is unavailable. The worker persists and retries it automatically;
new admissions and queue resume remain blocked until acknowledgment. Re-read
`profile list` after an uncertain result; retry only the same pending payload.
Run `queue resume` after `state: "ready"` when ready to accept work.

These commands call private `/api/repositories` and `/api/execution-profiles`
endpoints. See [repository consent](configuration.md#detected-installation-repository)
and [profile configuration](configuration.md#editable-execution-profiles) for
persistence, restart and compatibility behavior. The portable client’s
`schema` output supplies the current machine-readable command catalog.

## Worker consumption limits

Consumption is configured per worker through its portable client, using the same
`--state-dir` as startup or an explicit remote URL and credential:

```sh
node bin/apps/worker/cli.mjs consumption status
node bin/apps/worker/cli.mjs consumption configure --file consumption.json
```

`consumption.json` contains a complete policy under its settings wrapper:

```json
{"consumption":{"enabled":true,"period":"daily","allowance":1000000,"workerPercent":50,"perRunReservation":10000}}
```

The example allocates 500,000 input + output tokens per UTC day to this worker.
Use `monthly` for UTC calendar months. Limits start disabled, and accounting
persists across restarts and policy changes. Status returns measured usage,
outstanding reservations, remaining tokens, the next reset and any blocking
reason. These commands use authenticated `GET /api/consumption` and
`POST /api/settings`; stdout is JSON, and `--file -` reads stdin.

The limit prevents new model calls when budget or usage evidence is insufficient;
a current response can exceed its reservation. It does not measure personal use
or a provider subscription balance. See the
[consumption guide](../how-to/worker-consumption-limits.md) for validation,
concurrent edits, queue recovery and unknown-usage handling. The
[portable command reference](portable-apps.md#worker-consumption-limits) lists
the named commands and input wrapper.

## Native maintenance

`node werk.mjs maintenance backup --state-dir PATH --to NEW_BACKUP_DIRECTORY` copies complete stopped native line/system state with private checksummed manifest. `verify --from BACKUP_DIRECTORY` validates it; `restore --from BACKUP_DIRECTORY --to NEW_STATE_DIRECTORY` refuses existing destinations. `diagnose --state-dir PATH` reports ownership and disk pressure without changing locks. All support `--json`; success is 0, failed checks/I/O are 1, invalid input is 2. See [backup and recovery](../how-to/upgrade-backup.md) for limits, shutdown requirements, privacy and Docker procedures.

## Native release updates

Downloaded releases check stable GitHub releases before native up/start. Use `--no-update` for one startup or `WERK_AUTO_UPDATE=0` for automation. `node werk.mjs update check|apply|status|enable|disable` manages this behavior; use `--line` for a single-line state. See [automatic updates](updates.md) for path selection, backups and non-destructive recovery. Source checkouts do not perform update checks.
