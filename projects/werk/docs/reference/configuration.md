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
`executionSource` and rejects duration edits while the override is active; it
preserves the saved duration for later use after removing the override. Tool
budgets remain editable under that override. Other local
settings, including resource thresholds and provider configuration, remain in the
private state directory. Existing saved connection settings can replace startup
connection defaults; the CLI-over-environment rule above concerns the listed
operator defaults, not every saved worker setting.

Execution settings also include `maxToolCalls` (default 128, integer 1–512) and
`commandTimeoutMs` (default 300000, integer 1000–3600000). Policies saved without
these fields use those defaults. The command ceiling applies to fixed commands,
CLI tools and required feature checks; an optional per-grant timeout can shorten
it. The total `maxRuntimeMs` deadline can end any operation sooner. External MCP
calls default to 30 seconds with optional per-connection timeouts; web fetches
retain 10 seconds.
There is no independent two-minute tool window. The UI exposes these fields under
**Settings → Queue & duration → Tool execution limits**.

A successful verified-implementation snapshot reads and fingerprints every
tracked file and every nonignored untracked file in the candidate worktree. Three
execution settings bound that inspection:

| Setting | Default | Range | Bounds |
| --- | --- | --- | --- |
| `candidateSourceMaxBytes` | 67108864 (64 MiB) | 1048576–1073741824 | Total bytes of all inspected source files |
| `candidateSourceMaxFiles` | 20000 | 1–200000 | Inspected paths, including approved paths |
| `candidateFileMaxBytes` | 8388608 (8 MiB) | 65536–268435456, at most `candidateSourceMaxBytes` | One source file outside the approved paths |

Open **Settings → Queue & duration**, then expand **Repository inspection limits**
in the task-duration form. The size controls display MiB (1 MiB = 1,048,576 bytes);
**Maximum files** is a count. **Save execution limits** saves these values together
with duration and tool budgets. The environment duration override leaves inspection
limits editable. A per-file limit above the total source limit is refused.

Use the measured size or count in an inspection error to choose bounds that cover
the repository's committed documents and assets. A failed total-size inspection names its measured
size, limit and setting, for example `Candidate source is 91,852,341 bytes; the
inspection limit is 67,108,864 bytes (execution.candidateSourceMaxBytes).` A larger
bound permits more source to be inspected; it never skips files, widens approved
edit paths or sends the entire snapshot to the model. Untracked ignored outputs
are excluded; tracked files remain included even when an ignore rule matches them.
Three more execution settings bound what a reviewer receives from an
implementation candidate. They apply to exact approved files and to changed, added
or deleted files below approved folders (entries ending in `/`). Unchanged files
below an approved folder count only toward the inspection limits above. Proposal
requests keep their fixed bounds.

| Setting | Default | Range | Bounds |
| --- | --- | --- | --- |
| `candidateApprovedFileMaxBytes` | 24000 | 1000–8388608 | One approved file in the candidate |
| `candidateApprovedTotalMaxBytes` | 48000 | 1000–67108864, at least `candidateApprovedFileMaxBytes` | All approved text in the candidate |
| `candidateReviewPatchMaxBytes` | 120000 | 10000–4194304 (4 MiB) | The review patch |

Every changed approved file appears in the review patch, so `candidateReviewPatchMaxBytes`
also bounds approved content in practice: per-file and total values above the patch
limit only matter for exact approved files that stay unchanged.

Errors name the measured value, the limit and the setting, for example
`Approved candidate file "src/app/generated.ts" is 30,000 bytes; the approved file
limit is 24,000 bytes (execution.candidateApprovedFileMaxBytes).` The
`werk_candidate_apply` content schema states the frozen per-file limit. Raising
these limits never widens the approved paths: the review patch contains only
approved paths. These settings have no webview editor yet; use `settings set`.
The taskboard stores each review patch in one document limited to 16 MiB, so the
review patch maximum is 4 MiB; shared feature publication keeps its 128 KiB patch bound.
`werk_candidate_status` and `werk_candidate_apply` return a listing bounded to 64 KiB of
paths and hashes, well below the 128 KiB tool result limit. Exact approved files and
requested paths always keep their hashes; changed files follow with `changed: true`,
beyond the budget in `changedPathsWithoutHashes` and then counted in
`omittedChangedPaths`; up to 200 other files below approved folders fill the rest,
with `omittedFiles` counting those left out and `filesNote` explaining any gap.
`changedFileCount` is the complete number of changed files. The optional `paths`
argument of `werk_candidate_status` (at most 32) returns the hashes of specific
approved files. `werk_candidate_apply` refuses a path below an approved folder that
the repository's Git ignore rules exclude, naming the path.

The private settings API and `settings set --file` use whole bytes, for example
`{"execution":{"candidateSourceMaxBytes":134217728}}`. `settings get` shows the
effective values. For a guarded save, include the complete
`expectedCandidateInspection` object from the latest settings response's
`execution` fields; see the baseline contract below. Guard approved content edits
with the complete `expectedCandidateReview` object in the same way. Omitting a field
in a partial update preserves its saved value.

Each prepared dispatch freezes its duration and tool budgets, including while
queued or when execution uses that saved dispatch. An implementation dispatch also
freezes the three candidate source limits and the three approved content limits
and records them with its tool limit evidence
(`toolManifest.limits.candidateInspection` and `toolManifest.limits.candidateReview`).
Dispatches prepared before these settings existed use their defaults. A newly prepared follow-up,
answer or resume attempt captures current execution settings; it does not rewrite
the earlier dispatch or inherit its budget indefinitely.
See [long-running worker operations](../how-to/monitor-long-running-worker.md) for
monitoring scope, warning thresholds, shutdown and recovery.

## Worker queue and guarded settings saves

The private `GET /api/settings` response supplies each editor's saved baseline.
`POST /api/settings` supports optional comparison fields; the webview sends them
so a concurrent policy change returns a conflict before anything is written:

| Editor | Baseline field | Compared values |
| --- | --- | --- |
| Queue | `expectedBoard` | `queueCapacity`, `orchestratorQueue`, `order` |
| Queue & duration | `expectedDuration` | `maxRuntimeMs`, `longRunningMs` |
| Tool execution limits | `expectedToolBudget` | `maxToolCalls`, `commandTimeoutMs` |
| Repository inspection limits | `expectedCandidateInspection` | `candidateSourceMaxBytes`, `candidateSourceMaxFiles`, `candidateFileMaxBytes` |
| Approved content limits (CLI) | `expectedCandidateReview` | `candidateApprovedFileMaxBytes`, `candidateApprovedTotalMaxBytes`, `candidateReviewPatchMaxBytes` |
| Consumption | `expectedConsumption` | The complete saved consumption policy |

A guarded queue edit sends only queue limits/order in `board`; pause is an
independent `{board: {paused: boolean}}` action and cannot be overwritten by that
editor's stale draft. Duration edits patch `execution.maxRuntimeMs` and/or
`resources.longRunningMs`, preserving other resource thresholds. Tool-budget
edits patch `execution.maxToolCalls` and/or `execution.commandTimeoutMs` and use
the complete `expectedToolBudget` pair. Repository-inspection edits patch one or
more of their three execution fields and use the complete
`expectedCandidateInspection` baseline. The combined **Save execution limits**
action validates all supplied baselines before writing any fields. A conflict
retains the editor's draft so the operator can reload, reconcile and save again.
Legacy clients may omit these guards. Save acknowledgements and follow-up reads are separate:
a failed refresh does not undo an acknowledged save.

The session view includes an optional `capacity` snapshot (schema version 1),
returned through the existing `GET /api/chat/session` poll. It reports one shared
execution slot, local admission occupancy including preparation/resume
reservations, and the separate accepted remote-assignment buffer. Unadmitted
ready notes and retained finished tasks are not local occupancy. Reducing a limit
preserves accepted work and may leave it above the new limit. The snapshot also
carries its capture time, manual pause and consumption blocker; these observations
do not reserve admission or predict completion time. Stale data cannot establish
current readiness.

## Worker provider defaults

The worker's private `workspace-settings.json` stores `defaultProvider` and each
provider connection's `model` and optional `effort`. Edit them through **Settings
→ Providers & accounts** or the authenticated settings API/portable CLI; they
are separate from orchestrator execution profiles and project launch `.env`
keys. `GET /api/settings` exposes the redacted defaults. `POST /api/settings`
accepts a top-level `defaultProvider` update or a `provider` update containing
its `id` and changed configuration fields. Supply the observed
`expectedDefaultProvider` with a default-provider edit to reject a stale save;
refresh and reconcile on conflict. `settings get`, `settings set --file`
and `provider configure --file` use those routes.

`defaultProvider` must be `codex-cli`, `claude-cli`, `openai-api`, `anthropic-api`
or `cursor-cli`. `features.intake` in `.werk/worker.json` is `shared` (default) or `local`; `init --intake local` writes `local`, which keeps shared intake off on purpose and makes the detected checkout default to `watch: false`. The legacy startup `features.provider` is a seed only when no
saved default exists. A template or request with an explicit provider continues
to use it. Model and effort selections follow the
[shared selection contract](model-interaction.md#provider-model-and-effort-selection):
request override, compatible profile model, then provider default for models;
request override then provider default for effort.

Defaults apply to newly accepted work. Owned requests retain provider, model and
effort through their Ready Check, implementation, answers and restart recovery.
Saving defaults does not prove the account can use the chosen model or effort,
and never changes orchestration simulation into live execution.

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
the Taskboard prompt; Settings → Repositories lets the operator reconsider. Acceptance requires
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
them in **Settings → Repositories** or use `settings get` /
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
`repository sync [--id ID]`, and `repository accept|decline --discovery-id ID`. Accept also takes an optional boolean `watch` (CLI `--watch true|false`) for the new assignment; omitted, it follows `features.intake`.
See the [CLI contract](runtime-cli.md#worker-repositories-and-execution-profiles).

Managed Docker fleets reject checkout assignments because their generated mounts
do not expose repositories. Standalone project containers need a Git-enabled
image, writable repository mounts and paths valid inside the container. Assigning
repositories does not enable live model execution: mock tasks remain simulations,
and ordinary provider Chat does not gain arbitrary filesystem or shell tools.

## Local model tool access

The unlocked **Settings → Tools & MCP** section manages a separate private
`tool-access.json` in the worker state directory. Missing configuration means no grants. The document
records a numeric revision, worktree-file access, fixed command presets,
CLI tools, web origins, MCP connection details and discovered per-tool grants. A stdio
connection's `secretEnv` names the variable that receives its secret; it may be
empty only when the connection stores no secret, and an omitted value defaults to
`MCP_AUTH_TOKEN`. A command
preset or stdio MCP connection may add `"chatDirectory": "repository:<id>"`, which
names an assigned repository whose live checkout starts that grant's Chat calls
and MCP discovery. Omitted, Chat calls start in the private, empty
`chat-workspace` folder in worker state. Task invocations always use their task
worktree. Saving requires the repository to be assigned; calls recheck the
assignment and its resolved directory. Its credentials
are redacted from authenticated views; they never enter the public status or
model dispatch manifest. Preserve this file with the rest of stopped worker state.

A fixed command preset may set `verification: true` (omitted/false by default).
The UI calls this **Required feature check**. Together with file access and an
approved Git worktree, enabled verification presets define the frozen check plan
for new implementation requests. Candidate tools edit only approved paths and
record actual command outcomes; every required check must pass on the final
candidate. Existing proposal tasks are not converted by changing grants. See
[implement a feature](../how-to/implement-feature.md).

Per-grant timeouts are optional whole milliseconds. There is no separate
`limits.windowMs` tool-policy setting:

| Field | Omitted on a new grant | Numeric range |
| --- | --- | --- |
| `builtins.commands[].timeoutMs` | Inherit the accepted `execution.commandTimeoutMs` | 1,000–3,600,000 |
| `builtins.cliTools[].timeoutMs` | Inherit the accepted `execution.commandTimeoutMs` | 1,000–3,600,000 |
| `mcp[].timeoutMs` | 30,000 | 1,000–900,000 for stdio; 1,000–300,000 for HTTP |

Command/CLI/required-check deadlines are capped by the frozen global command
ceiling. MCP deadlines are independent of that ceiling. All calls remain bounded
by cancellation and the remaining total invocation duration.

For updates, an absent `timeoutMs` preserves an existing override for the same
ID; `null` clears it. Explicit numeric defaults remain saved. This preservation
also applies when an MCP destination changes, while its secrets and discovered
grants follow the separate destination identity rule. Changing to HTTP with a
retained timeout above 300,000 requires a valid replacement or explicit reset.
A required check's fingerprint includes its timeout override when present;
changing that override does not silently rewrite an accepted verification plan.
See [execution limits](../how-to/manage-model-tools.md#execution-limits).

Each entry in `builtins.cliTools` describes one command-line tool the model may
call with its own arguments in the task worktree:

| Field | Contract |
| --- | --- |
| `id` | 1–48 letters, digits, `_` or `-`. The model sees the tool as `werk_cli_<id>`. |
| `name`, `description` | Display name (≤ 120 characters) and optional model-facing description (≤ 1,000). |
| `enabled` | `false` keeps the configuration without offering the tool. |
| `executable` | Absolute path on the worker machine; `.bat` and `.cmd` files are rejected. |
| `args` | Up to 32 fixed leading arguments, for example `["bin/harness.mjs"]`. Relative paths resolve in the task worktree. |
| `commands` | 1–64 rules. `command` is one or two literal words. Optional `requireOneOf` lists flags of which one must be present; optional `refusedOptions` adds refusals for that command. |
| `refusedOptions` | Up to 32 option names refused for every command, such as `--root`. |
| `maxArgs`, `maxArgLength` | Model argument bounds: default 24 (1–64) and 500 characters (1–2,048). |
| `outputKiB`, `truncationHint` | Returned output limit, default 32 (1–64), and the hint appended to truncated output. |
| `timeoutMs` | Optional deadline, 1,000–3,600,000 milliseconds, capped by the accepted global command ceiling. Omitted new values inherit that ceiling. |

Absolute paths, `~`, `file:` URLs, `@file` paths, `..` segments, the `--`
terminator and control characters in model arguments are always refused, including
response-file and path values extracted from options. Required flags must be
standalone and unique; assigned, negated and clustered forms cannot satisfy or
override a required flag. These checks do not establish the CLI's behavior or
confine its filesystem access. At most
eight CLI tools may be configured; each enabled CLI tool counts toward the
64-tool limit. Documents without `cliTools`, including those written by 0.9.0,
grant none. An empty list is omitted from the saved document so 0.9.0 can read it.
Before rolling back to 0.9.0, remove all CLI tool entries, clear verification
marks and clear every per-grant timeout with `timeoutMs: null`, then save tool
access while running the current version. Disabling entries, omitting existing
overrides or explicitly saving numeric defaults leaves configuration the older
version does not understand. Reset global tool budgets to 128 calls and 300000
milliseconds and save; those global default budget fields are omitted from saved
workspace settings for compatibility. If retained task state is incompatible,
restore the pre-upgrade stopped-state backup.

Tool changes require paused, drained execution and the current policy revision.
Local request invocations resolve current Werk grants. Codex, Claude and API
request reviewers stay tool-free; Cursor reviews use native read-only ask mode
under Cursor permissions/hooks. Repository assignment, provider sign-in and
execution profiles do not implicitly grant Werk tools. Cursor native tools use
its separately configured operator policy. See
[manage model tools](../how-to/manage-model-tools.md).
