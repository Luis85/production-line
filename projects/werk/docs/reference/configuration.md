# Runtime configuration and state

The default state directory is `.werk` beside the release launcher. Select another
location with `--state-dir PATH` and reuse that argument for every operation.
Native and Docker launchers share the configuration/credential format and require
an explicit runtime choice; sharing a format is not permission to run both at once.

For a Factory hierarchy, use the [system definition](system-definition.md) and
its separate `.werk-system/<id>` state. The format below configures one line.

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
Review them before cleanup; use `git worktree list` and Git's normal
`git worktree remove PATH` for reviewed clean worktrees. Do not delete a worktree
while a task is using it. Back up repositories and retained worktrees separately
from private worker state.

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
