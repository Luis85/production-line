# Runtime configuration and state

The default state directory is `.werk` beside the release launcher. Select another
location with `--state-dir PATH` and reuse that argument for every operation.
Native and Docker launchers share the configuration/credential format and require
an explicit runtime choice; sharing a format is not permission to run both at once.

For a Factory hierarchy, use the [system definition](system-definition.md) and
its separate `.werk-system/<id>` state. The format below configures one line.

## Project environment files

Independent Factory, orchestrator and worker apps support a project-root `.env`
and a credential-free `.env.example`. Project worker `init` creates them
automatically. For any copied app, initialize its section explicitly:

```sh
node bin/apps/worker/cli.mjs env init --project-dir /absolute/project --state-dir /absolute/project/.werk/worker
node bin/apps/orchestrator/cli.mjs env init --project-dir /absolute/project --state-dir /absolute/project/.werk/orchestrator
node bin/apps/factory/cli.mjs env init --project-dir /absolute/project --state-dir /absolute/project/.werk/factory
```

Each app reads only its supported keys from `.env` in `--project-dir`, otherwise
its current working directory. The portable CLI loads it for launches and local
client commands. The root launcher's `factory run` and `orchestrator run`
commands use the same boundary. Use the portable worker CLI for project dotenv
loading; lower-level worker commands still accept process environment directly.
Managed `up`/`system` deployments retain their separate state/YAML configuration.

| Application | Supported project keys | Defaults when initializing |
| --- | --- | --- |
| Worker | `WERK_WORKER_TOKEN`, `WERK_WORKER_STATE_DIR`, `WERK_WORKER_HOST`, `WERK_WORKER_PORT`, `WERK_WORKER_CONFIG`, `WERK_WORKER_ORCHESTRATOR_URL`, `WERK_WORKER_MAX_RUNTIME_MS`, `WERK_ENROLLMENT_TOKEN` | `.werk/worker`, `127.0.0.1`, `4100`; optional config/upstream/duration keys are documented in the example |
| Orchestrator | `WERK_ADMIN_TOKEN`, `WERK_ENROLLMENT_TOKEN`, `WERK_ORCHESTRATOR_STATE_DIR`, `WERK_ORCHESTRATOR_HOST`, `WERK_ORCHESTRATOR_PORT`, `WERK_ORCHESTRATOR_PROJECT` | `.werk/orchestrator`, `127.0.0.1`, `3000`, project `demo` |
| Factory | `WERK_FACTORY_ADMIN_TOKEN`, `WERK_FACTORY_STATE_DIR`, `WERK_FACTORY_HOST`, `WERK_FACTORY_PORT` | `.werk/factory`, `127.0.0.1`, `3100` |

Explicit CLI launch options override namespaced environment defaults; the process
environment overrides `.env`. These launch defaults then precede saved project
startup defaults and built-in values. Relative environment `STATE_DIR`/`CONFIG`
paths resolve against the selected project directory. Worker private settings
have their own update contracts: for example, a saved orchestrator connection can
still replace its startup URL, and saved repository assignments override file
seeds. An environment URL does not silently replace that saved connection.

Only supported assignments are interpreted. Unknown keys and existing comments
are preserved. Duplicate supported keys, invalid supported syntax and multiline
values are rejected. Optional quotes, `export` and comments are supported;
`${VAR}` and `$(command)` stay literal and are never expanded or executed. Files
must be regular, stable UTF-8 files of at most 64 KiB. A credential-bearing `.env`
must be private on POSIX; reads do not silently repair permissions.

Initialization appends missing keys and preserves existing bytes/values. Missing
local tokens use an explicit process value, then existing selected private state,
then a newly generated value. Worker access and component admin/enrollment tokens
are 64 lowercase hexadecimal characters; worker enrollment accepts 24–4096
characters and may be omitted or blank for standalone operation.
`.env.example` contains commented placeholders, never generated credentials.
Setup appends `.env` and `!.env.example` ignore rules before writing secrets,
refuses tracked `.env` mutations and symlink/hardlink destinations, and can tighten
an ordinary untracked `.env` to mode 0600. Native Windows inherits ACLs; protect
that file using the worker account's access controls. Results contain file paths
and added key names, never token values.

Stop an app before intentionally rotating its local access token. Change the
supported token in `.env` or the higher-precedence process environment, then
restart; startup synchronizes it to the private credential state used by local
clients. Changing a line project still requires compatible saved state; a dotenv edit
is not an identity migration. Removing an environment assignment preserves the
last saved token.
Deleting only the saved worker `webview-token` does not rotate an active
environment override. Worker enrollment credentials remain separate from its
webview access token and do not replace an already registered worker identity.

A portable client with explicit remote `--url` requires an explicit `--token-file`
or process `WERK_APP_TOKEN`; project `.env` never supplies that credential.
`status` and `stop` with explicit `--state-dir` bypass project dotenv loading so
an invalid local file cannot prevent recovery. Use the same state directory that
owns the running process.

## Native operator environment defaults

| Variable | Consumer / default |
| --- | --- |
| `WERK_STATE_DIR` | Default for `--state-dir` on native single-line and system actions; absent uses `.werk` or `.werk-system/<id>` beside the release |
| `WERK_SYSTEM_FILE` | Default for native `system --file`; required for plan/setup/start/up unless an explicit file is supplied |
| `WERK_LOG_OUTPUT` | Default for native `start` and `system up/start --log-output`: `file`, `stream` or `both`; absent uses `file` |

Explicit matching CLI flags take precedence. Empty environment values are absent;
invalid nonempty log modes are rejected before startup. These are native operator
defaults, not a promise that Docker wrappers interpret the same variables. Keep
paths absolute in services and reuse the same selection for maintenance. To use
saved-state-only system maintenance, also unset `WERK_SYSTEM_FILE` if a stale or
missing definition would otherwise be selected.

`file` stores bounded private supervisor logs. `stream` emits sanitized service
records through foreground stdout without creating supervisor log files, including
nested line logs. `both` streams and writes the rotating files. This does not remove
SQLite databases, worker journals or other necessary state. See
[observability](observability.md) for framing and retention. One-shot `--json`
commands still emit one result object; foreground `--json` remains JSON lines.

The [Linux VM profile](infrastructure.md) uses an external state directory and
stream mode for journald; it stores these nonsecret defaults in `/etc/werk/runtime.env`.

## Configuration

`config.json` is versioned JSON. It lives directly in native/Linux bind state, or
inside the Windows Docker named volume. The initial native configuration is:

```json
{
  "schemaVersion": 1,
  "runtime": "native",
  "project": "demo",
  "orchestratorPort": 3000,
  "workerPort": 4100,
  "workers": 1,
  "mode": "mock"
}
```

Native setup flags configure the project, ports, worker count and runtime. Native
supports 1–8 workers; Docker currently supports one. Worker status ports are
contiguous starting with `workerPort` and must not overlap the orchestrator port.
The default mode is `mock`; native deployments can explicitly enable `cli` with
a matching execution policy. `runtime` selects native or Docker deployment. Setup preserves valid existing configuration and credentials.
Stop services before a deliberate configuration or deployment change. Existing
worker identities are bound to their connection/configuration: changing ports,
project or worker configuration may require a new worker state and an explicitly
planned migration. A stopped edit is not an automatic identity migration. The
[execution-profile editor](#editable-execution-profiles) provides a guarded update
for profile IDs/providers without replacing that identity or changing deployment mode.

## State and credential ownership

| State | Purpose |
| --- | --- |
| `config.json` | Versioned runtime/deployment configuration |
| `credentials.json` | Distinct admin and enrollment secrets; private, not source-controlled |
| `orchestrator.sqlite` and SQLite sidecars | Line tasks, leases, receipts and evidence index |
| `workers/worker-N/` | Per-worker identity, snapshots and durable pending work |
| Supervisor metadata and `logs/` | Lifecycle coordination and diagnostics; not a substitute for persisted task evidence |

### Windows Docker storage

The host state directory contains `docker-volume.json` and nonsecret `docker.env`.
The pointer has `{schemaVersion: 1, volume, installation}`. Volume names follow
`werk-<first 12 installation hex characters>-state`; the installation identity is
a 32-character hexadecimal GUID. The Docker volume label `dev.werk.installation`
must match that identity. Configuration, credentials, database and worker state
are inside the named volume, with Linux permissions preserved. Copying only the
host `.werk` directory does **not** back up that runtime.

`./werk-docker.ps1 credentials` explicitly exports a private copy to a new
`.werk/credential-export/credentials.json` and reports only its path. The export
directory is restricted to the current Windows user and is never overwritten.
Stop does not delete the volume. Native setup rejects this Docker state pointer.

Keep the complete state together for backup. Native state directories/files enforce POSIX 0700/0600 access. On Windows, native
files inherit filesystem ACLs; the native operator does not validate those ACLs.
Apply account-specific access controls and protect backups similarly. Do not copy state into a release archive or Git repository.

## Application client environment

| Variable | Consumer / meaning |
| --- | --- |
| `WERK_URL` | Orchestrator HTTP URL for the client or worker |
| `WERK_ADMIN_TOKEN` | Administrative client/browser access to one line |
| `WERK_ENROLLMENT_TOKEN` | Worker enrollment; registration creates a separate persisted worker credential |
| `WERK_FACTORY_URL` | Optional Factory client URL |
| `WERK_FACTORY_ADMIN_TOKEN` | Optional Factory administrative access |

Admin and enrollment secrets are distinct. Factory credentials are separate from
line credentials. Provider CLI logins are not Werk tokens and are not needed for
the packaged mock path. The release operator reads its managed credential file;
these environment variables describe the lower-level application clients.

Source-development fleet launchers have separate `.state` directories and
additional development environment flags. Their setup is not the release
operator contract. See [runtime layout](../explanation/runtime-layout.md).

## Local worker execution policy

`WERK_WORKER_MAX_RUNTIME_MS` is an authoritative process-environment override for
local model invocations: integer milliseconds from 1000 to 86400000. Absent, the
saved private workspace execution setting applies, otherwise the default is six
hours. Empty/invalid values fail startup. The private settings API exposes
`executionSource` and rejects execution edits while the override is active; it
preserves the saved value for later use after removing the override. Other local
settings, including resource thresholds and provider configuration, remain in the
private state directory. Existing saved connection settings can replace startup
connection defaults; the CLI-over-environment rule above concerns the listed
operator defaults, not every saved worker setting.

A dispatched invocation freezes its duration policy; edits affect later calls.
See [long-running worker operations](../how-to/monitor-long-running-worker.md) for
monitoring scope, warning thresholds, shutdown and recovery.

## Editable execution profiles

The private worker endpoint `GET /api/execution-profiles` returns
`{schemaVersion: 1, profiles, configurationHash, mode, allowedProviders, maxProfiles,
state, pending, canEdit, saveBlockedReason}`. `profiles` and `configurationHash`
describe the active configuration; `pending` is null or a requested
`{profiles, configurationHash}`. `state` is `ready` or `pending`.

Send `POST /api/execution-profiles` with only `expectedConfigurationHash` and
`profiles`. Each profile has `{id, provider, mode, maxParallel: 1}`. Use the hash
returned by the latest GET; a stale hash conflicts. IDs are unique, 1–100 letters,
digits, underscores or hyphens. A mock worker accepts 1–8 profiles with provider
`claude` or `codex` and mode `mock`. The native Linux Codex adapter accepts
exactly one `codex` profile with mode `cli`. Mode changes and additional execution
slots are rejected. All profiles share the worker’s one slot; provider sign-in,
model settings and imported agent definitions are separate configuration.

Saving requires paused intake and no queued/running tasks, active replies or
repository preparations. Before first registration, a valid change applies
immediately. After registration, the worker durably stages it until the same
orchestrator acknowledges it. Active profiles remain unchanged while pending;
new local/remote admissions, queue resume and a different profile edit are blocked.
An identical pending request may be retried. Read status after an uncertain response
and compare the active/pending profiles before submitting a new change.

The worker retries at its normal orchestration poll interval (100–30,000 ms,
plus up to 250 ms jitter). Offline saves survive restart. Going standalone keeps
the update pending until reconnecting to the same orchestrator. An older
orchestrator returning 404 must be upgraded; automatic retries then continue.
Acknowledgment updates the existing worker identity in place and preserves its
credential, sessions and history, including the provider/mode recorded for past
attempts. The private `execution-profiles.json` belongs to worker state; startup
JSON is unchanged. Its base hash rejects reuse with a different startup
configuration rather than silently applying an incompatible override.

The worker uses its own credential for `POST /v1/worker/profiles`, with
`{profiles, expectedConfigurationHash, configurationHash}`. The orchestrator
returns `{profiles, configurationHash}`, accepts an exact replay, and rejects
stale hashes or active/accepted queued leases. This is not an administrative
endpoint for changing another worker.

## Detected installation repository

At startup the worker locally inspects its integration project directory, otherwise
`--project-dir`, otherwise its startup working directory. The resolved directory
must itself be a Git checkout root with a `.git` directory or regular Git file;
linked worktrees are supported. It never walks upward to select an ancestor.
Detection does not fetch, pull or create worktrees.

An unconfigured candidate requires an explicit saved accept/decline. Acceptance
adds a generated assignment ID and enables watching only when a current branch
and remote exist; detached HEAD or no remote gives `watch: false`. Such checkouts
can still supply committed file-task inputs. Add/configure a remote or select a
branch yourself, then enable watching through repository settings. A first commit
is required before task worktrees can be created.

Both decisions persist privately in `repository-discovery.json`. Decline hides
the Taskboard prompt; Dashboard lets the operator reconsider. Acceptance requires
idle queues and preparations; decline can be recorded while unrelated work runs.
Existing explicit repository assignments, including a matching configured legacy
Codex repository, count as authorization. Explicitly assigning a skipped checkout
also accepts it. Removing an assignment does not erase its saved acceptance;
legacy use remains subject to the ordinary repository-selection rules below.
The worker revalidates repository identity before watching and task preparation;
replacing the checkout at the same path requires a fresh choice. Neither a pending
nor a declined checkout can be used through the legacy absolute-directory input.

## Assigned Git repositories

A worker can own up to 64 existing Git checkouts. Add a top-level `repositories`
object to worker JSON (for example `.werk/worker.json`), or set it through the
private worker settings API. Native single-line `config.json` accepts the same
object; system YAML uses `productionLines[].workers.repositories`.

```json
{
  "repositories": {
    "pollMs": 30000,
    "items": [
      { "id": "app", "path": "/srv/app", "remote": "origin", "branch": "main", "watch": true },
      { "id": "docs", "path": "/srv/docs", "remote": "origin", "watch": true }
    ]
  }
}
```

This fragment merges with the rest of the configuration; preserve existing
feature-folder and execution settings. IDs use 1–100 letters, digits, underscores
or hyphens and must be unique. Paths must identify different checkout directories.
Worker JSON resolves relative paths against `--project-dir` or its working
directory; private settings and managed deployment configuration require absolute
paths on the worker machine. Each checkout needs a commit and Git on the worker's
PATH. Clone repositories and configure their remote authentication beforehand;
the worker uses the existing Git account and never stores Git credentials here.

`pollMs` defaults to 30,000 and accepts 1,000–3,600,000 milliseconds. The remote
defaults to `origin`, and `watch` defaults to `true`. An omitted branch follows
the checkout's current branch. An explicit branch must match the checkout's
current branch; the worker does not switch branches. Remote values are existing
Git remote names, not URLs or commands. Unknown fields and invalid refs are rejected.

Watching polls and fetches the selected remote, then fast-forwards a clean,
behind checkout. Dirty files, local commits and divergent histories are preserved;
there is no reset, stash, rebase, automatic merge or push. Status reports the
condition or failed fetch. A remote outage still permits tasks from the current
local committed HEAD. `watch: false` disables periodic synchronization for that
repository; an explicit sync remains available.

Each assigned coding task gets a detached Git worktree under
`<repository>/.werk/worktrees/`, pinned to a committed base. Uncommitted source
edits are excluded. The managed directory is excluded through Git's local exclude
file. Source checkout files stay separate from task edits; background pulls do
not change an existing task's base. Worktrees survive worker shutdown and restart.
Back up repositories and retained worktrees separately from private worker state.

Set the optional `repositories.worktreeDirectory` to an absolute folder outside
every checkout to create new task worktrees there instead, for example when
project tools such as a vault linter scan `.werk/worktrees`:

```json
{ "repositories": { "pollMs": 30000, "worktreeDirectory": "D:\\werk-worktrees", "items": [ { "id": "app", "path": "D:\\src\\app", "remote": "origin", "watch": true } ] } }
```

The parent folder must exist; the worker creates the folder itself as an ordinary
directory and rejects a location inside a checkout or its Git directory. Several
repositories can share it: names start with the assignment ID. On Windows choose
a short path; worktree and Git administration path limits are checked before
checkout. Existing worktrees stay at the location recorded in their ownership
marker and are still verified there after the setting changes. The default
(setting omitted or empty) keeps `<repository>/.werk/worktrees/`. `settings set`
replaces the whole `repositories` object, so include `items` and the directory.
The setting applies to assigned repositories; unassigned legacy Git folders keep
the in-checkout location.

Checkout uses Git's parallel checkout (`checkout.workers`, at most 8); on Windows
it falls back to a serial checkout when the worktree's Git administration path
exceeds Git's 220-byte `GIT_DIR` limit, so short repository paths check out
faster. One
120-second budget covers repository queueing, fetch, checkout and verification of
a new task worktree; with `"background": true` on file-task creation the request
returns at once and the budget is 10 minutes. `worktree add` itself may run up to
5 minutes within that budget, independent of short Git metadata timeouts.

Deleting a file task removes its worktree when it is clean and still verifiably
owned: the recorded identity (device, inode, creation time), ownership marker,
registration with the repository, detached HEAD at the recorded base, and no
operator lock. A worktree with uncommitted or untracked files is kept unless the
delete sets `discardChanges: true`. One with commits on its detached HEAD, a lock,
or any symbolic link or junction inside is always kept for manual review: Git for
Windows deletes through junctions, also in ignored folders and without `--force`.
`removeWorktree: false` keeps it; `removeWorktree: true` fails the deletion unless
the worktree was removed. The delete response includes `worktree.outcome`
(`removed`, `kept` with `reason`, or `not_applicable`).

`GET /api/worktrees` lists ownership records of each assigned repository with
state `present`, `missing`, `incomplete` (interrupted checkout), `locked`,
`unregistered` or `invalid`, the location (`repository` or `external`) and the
`taskId` of a file task still using it. `POST /api/worktrees`
`{"action":"prune","dryRun":true}` reports what would be removed;
without `dryRun` it removes, under the same rules, worktrees that no file task
uses, such as those left by interrupted admissions or retained Codex runs. `id`
selects one worktree name, `repositoryId` one assignment and `discardChanges`
also removes changed and interrupted ones. Pruning requires no queued, running or
admitting work; a dry run is always available. Never delete task worktree folders
with a recursive file delete; use these commands or `git worktree remove` after
checking for links.

Local file tasks select an assignment ID in their existing `repository` field;
an assigned absolute checkout path is also accepted. With assignments configured,
other paths are rejected. Provider file tasks read approved snapshots from their
worktree and produce a review patch; that worktree holds the captured input.
Native Codex tasks select an assignment by optional `task.repository`, falling
back to `task.project` when omitted, and retain the actual modified worktree.
`project` remains the line/enrollment scope: use `repository: "docs"` with the
same line project to select a second assigned checkout. The repository field is
an assignment ID, not a path or remote URL; it does not change the orchestrator
context binding or relax pinned-commit validation. Its operator-defined `allowedPaths` still applies to every
selected repository. Legacy `execution.codex.repository` remains supported when
no assignments are configured. Feature-folder patch requests target the installed
project directory, which must be assigned when assignments are configured.
Without assignments, local file tasks still accept non-Git directories as bounded
snapshots; those tasks have no Git worktree or committed-base provenance.

Connected workers advertise their saved assignment IDs when enrolling and on each
claim. The orchestrator matches an explicit task repository against those IDs;
CLI tasks without a selector match their project ID. The legacy single-repository
fallback is advertised separately and does not accept explicit assignment IDs.
An unscoped mock task remains eligible without a repository. The Factory uses
observed repository capacity when choosing a line, so an assignment can differ
from the line's project without being sent to an incompatible worker.

The registration policy and claim body accept optional `repositoryIds` (up to 64
unique assignment IDs) and `legacyRepository` (boolean, requiring that array).
An empty array withdraws all explicit assignments. Omitting both on a later claim
preserves the stored scope; old workers that never advertised a scope retain their
legacy behavior. These runtime capabilities do not change the enrollment
configuration hash. They identify available checkouts, not filesystem permissions;
worktree preparation still validates the selected repository and pinned commit.

Repository assignment changes require queued and running tasks to be drained.
Saved private worker settings take precedence over the initial file seed on later
starts; editing startup JSON does not overwrite saved assignments. Inspect or edit
them in Dashboard's **Git repositories** section or use `settings get` /
`settings set` on the worker CLI.

Authenticated `GET /api/repositories` returns
`{schemaVersion: 1, pollMs, items: [...], discovery}` with current repository status.
`discovery` is null or `{id, path, currentBranch, remote, watch, decision, repositoryId?}`.
`currentBranch`/`remote` may be null; `decision` is `pending`, `accepted` or `declined`.
The discovery `id` is an opaque repository-identity SHA-256, distinct from its
assignment `repositoryId`; `watch` describes the proposed acceptance default.
`GET /api/environment` includes the same view as `repositories`.
`POST /api/repositories` with `{"action":"sync","id":"app"}` requests a sync;
omit `id` to sync all assignments. `{"action":"status"}` refreshes status.
To record a detected-repository choice, send
`{"action":"accept","discoveryId":"ID_FROM_STATUS"}` or
`{"action":"decline","discoveryId":"ID_FROM_STATUS"}`. Do not send assignment
`id` with these actions; a stale discovery ID conflicts and requires a fresh
inspection. The portable worker CLI exposes `repository status`,
`repository sync [--id ID]`, and `repository accept|decline --discovery-id ID`.
See the [CLI contract](runtime-cli.md#worker-repositories-and-execution-profiles).

Managed Docker fleets reject checkout assignments because their generated mounts
do not expose repositories. Standalone project containers need a Git-enabled
image, writable repository mounts and paths valid inside the container. Assigning
repositories does not enable live model execution: mock tasks remain simulations,
and ordinary provider Chat does not gain arbitrary filesystem or shell tools.

## Local model tool access

The unlocked worker Dashboard manages a separate private `tool-access.json` in
the worker state directory. Missing configuration means no grants. The document
records a numeric revision, read-only worktree-file access, fixed command presets,
web origins, MCP connection details and discovered per-tool grants. Its credentials
are redacted from authenticated views; they never enter the public status or
model dispatch manifest. Preserve this file with the rest of stopped worker state.

Tool changes require paused, drained execution and the current policy revision.
Local Chat and approved-file task invocations resolve current grants; automated
request reviewers stay tool-free. Repository assignment, provider sign-in and
execution profiles do not implicitly grant tools. See
[manage model tools](../how-to/manage-model-tools.md).
