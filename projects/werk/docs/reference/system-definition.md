# System YAML definition

One YAML file describes a Factory and its production lines for native or
Docker execution, with simulation by default. The shipped [example](../../examples/system.yaml) creates one
Factory with Alpha and Beta lines, each with one worker. Keep credentials and task seeds outside this file. The optional native Linux
Codex policy declares exact operator-approved executable/repository paths; it
does not accept arbitrary shell commands.

The packaged [JSON Schema](../../schemas/system.schema.json) describes the file
structure for editors and validation tools. Runtime validation also checks global
port uniqueness, hierarchy references/cycles, reserved IDs and bounded YAML input.

## Schema version 1

| Field | Type and meaning |
| --- | --- |
| `schemaVersion` | Integer `1` |
| `id` | Stable system/deployment slug: 1–63 lowercase characters, starting with a letter; letter/digit groups separated by single hyphens |
| `environment` | `native` or `docker`; explicit CLI override can select the deployment environment |
| `factory.id` | Stable Factory slug using the same ID rules |
| `factory.name` | Human-readable Factory name, 1–120 characters |
| `factory.port` | Host port for the Factory web/API service |
| `factory.subFactories` | Optional flat list of `{id, name, parentId?}` logical branches; `parentId` defaults to the root Factory |
| `productionLines` | Array of 1–8 independently owned lines |
| `productionLines[].id` | Unique line slug using the same ID rules |
| `productionLines[].name` | Human-readable line name, 1–120 characters |
| `productionLines[].factoryId` | Optional root/subfactory parent; defaults to the root Factory |
| `productionLines[].project` | Project/enrollment scope: 1–100 letters, digits, underscores or hyphens |
| `productionLines[].orchestrator.port` | Host port for that line's Intake/API |
| `productionLines[].orchestrator.webviewUrl` | Optional public HTTPS origin for browser links only; no credentials, non-root path, query or fragment |
| `productionLines[].workers.count` | Integer 1–8 worker processes |
| `productionLines[].workers.statusPort` | First host status port; the remaining workers use consecutive ports |
| `productionLines[].workers.execution` | Optional native Linux Codex policy; requires `count: 1`. See below. |
| `productionLines[].workers.repositories` | Optional native repository assignments: `{pollMs, items: [{id, path, remote?, branch?, watch?}]}`. |

Slugs do not end in a hyphen and cannot be reserved device names such as `con`,
`nul` or `com1`. Names are trimmed, nonempty and contain no control characters.
The definition must be one UTF-8 YAML 1.2 document of at most 64 KiB, with unique
string mapping keys. Aliases, anchors, explicit/custom tags and multiple YAML
documents are rejected; nesting and node counts are bounded.

Ports are integers 1–65535. Factory, every orchestrator and every worker-status
port must be globally distinct, and worker ranges must fit within that limit.
IDs and port collisions fail validation before launch. Up to 32 Factory entities
(root plus subfactories) share one server/database. Factory IDs are unique, parent
IDs and line `factoryId` references must exist, and cycles are rejected. Normalized
plans make default parent IDs explicit. Unknown fields and inline
secrets are rejected rather than interpreted as extra runtime instructions.

`project` is a line's task/enrollment scope, not a Factory ID or repository path.
The same project label may be used on separate lines; each line still owns its
own task history and worker identities. Worker counts configure process slots,
not provider sessions or already-enrolled worker IDs. See
[core entities](../explanation/core-entities.md).

## Optional live Codex policy

`workers.execution` accepts `mode: cli`, optional `timeoutMs` (1,000–3,600,000;
default 300,000), and `codex` with an absolute `executable`, an optional legacy
`repository` path, and `allowedPaths` (1–32 unique, exact relative regular-text paths). Hidden,
traversal and common credential/key paths are rejected. Policy belongs to the
operator; task content cannot select these paths or executables. Native Linux
and one worker per live line are required. Docker overrides and the managed
cloud-init profile reject live policies. Omit `execution` for simulation.

With `workers.repositories`, each native Codex task selects the assignment whose
ID equals `task.repository`, or `task.project` when `repository` is omitted.
The task project remains the line scope, so one connected worker can use several
checkouts by selecting different repository IDs on tasks with the same project.
The legacy `codex.repository` may then be omitted.
Assignments use existing absolute checkout paths and are passed to each worker on
the line. Watching fetches and fast-forwards clean bases, while task worktrees
remain pinned. Saved worker settings override the initial assignment seed on
later starts. Managed Docker fleets reject assignments because their mounts do
not expose checkouts. See [repository configuration](configuration.md#assigned-git-repositories)
for the complete assignment and worktree contract.

Plans report `mode: mock|cli|mixed`. Live tasks require explicit `executionMode: cli`
and provider `codex`; successful execution yields `review`, never a simulated
completion or automatic merge. Use only trusted tasks and repositories under a
dedicated account: workspace-write limits writes but does not isolate host file
reads. Follow [the live workflow](../how-to/run-codex-task.md) for setup, provider
authentication, patch verification and human review.

## Operator actions

Native entry point:

```text
node werk.mjs system plan --file runtime/examples/system.yaml --json
node werk.mjs system setup --file runtime/examples/system.yaml
node werk.mjs system up --file runtime/examples/system.yaml
node werk.mjs system start --file runtime/examples/system.yaml
node werk.mjs system status --file runtime/examples/system.yaml --json
node werk.mjs system doctor --file runtime/examples/system.yaml --json
node werk.mjs system stop --file runtime/examples/system.yaml
```

Use `plan` to validate and inspect the effective topology. `setup` prepares private
state without running the services. `up` performs setup and starts the system.
`start` requires an existing matching setup. Native execution remains in the foreground and
opens the Factory landing page after the whole system is healthy. `status` and
`doctor` inspect the running system; `stop` shuts down workers, then lines, then
Factory. `--no-open` on start/up suppresses browser launch; `--json` is the machine
interface. Native start/up also accept `--log-output file|stream|both`.
`WERK_SYSTEM_FILE`, `WERK_STATE_DIR` and `WERK_LOG_OUTPUT` supply native defaults;
explicit flags win. See [configuration](configuration.md).

Docker uses the same system action and definition through `bash werk-docker.sh`
or `./werk-docker.ps1`, with `--environment docker` when the file selects native.
No host Node/npm is required for Docker. Both environments support the declared
1–8 lines and 1–8 workers per line; these are system-topology limits, separate from
the legacy single-line Docker helper's one-worker limit. The default state location is
`Home/state/system` through the stable Home launcher; `--state-dir PATH` selects a different
system state directory, not a parent directory containing another ID level. Keep
the file/environment/state selection consistent for every command. Native
`status`, `doctor` and `stop` also accept `--state-dir PATH` without `--file`,
using the saved topology so an edited YAML file does not prevent maintenance. The single-line operator remains available with its separate
`.werk` state contract.

## Native machine output

`plan --json` returns `{ok: true, stateDir, plan}`. The plan includes the normalized
IDs and environment, Factory/line URLs, worker status-port ranges and totals for
logical factories, production lines and workers. It contains no secret values.
Setup returns a `created` flag and the effective definition. Status includes its
lifecycle state and the saved definition's plan.

`up --json` and `start --json` remain in the foreground and emit lifecycle JSON
lines with `ok: true` and events such as `starting`, `ready`, `stopping` and
`stopped`. Wait for `ready`; process creation alone does not establish readiness.
JSON mode suppresses browser opening. Doctor returns `{ok, state, checks}`;
a stopped system can pass its preflight checks without being running.

Native exit codes are 0 for success, 2 for rejected input/configuration and 1 for
runtime or doctor failure. Exceptions return `ok: false` with
`error: {code, message}`; an unhealthy doctor describes failures in `checks`.
Docker `plan` returns the enriched plan directly, without the native `ok/stateDir`
envelope. Docker `up` performs idempotent setup if needed; `start` requires an
existing matching setup. Both start detached containers, validate
health/registration and optionally open Factory. Their status result includes `schemaVersion`, `environment: docker`,
`execution: mock`, system `id`, `ready`, `url`, `factory` health and per-line worker
readiness. Check `ready` and exit status; do not expect native lifecycle JSON lines.
Docker errors use stderr and nonzero exit. A stopped Docker system reports
`ready: false` and exits 1. A partial start/up failure preserves state and any
services already running; inspect `system status`, then use `system stop` before
recovery.

Docker plan may pull/cache its Node base image, but creates no system state or
services. Setup/start build the image from packaged distributions without npm
installation or compilation. The generated Compose file is
`<state>/docker-compose.json`, with its project name in `<state>/docker-project`.
Both Docker wrappers offer `system credentials`: Linux reports its private
credential directory; Windows explicitly exports into the protected host export
directory described below.

See [monitoring](../how-to/monitor-runtime.md) for readiness, capabilities and logs.

In native `file`/`both` mode, lifecycle logs live at `<system-state>/logs/runtime.jsonl`; each line's
lifecycle logs remain under `<system-state>/lines/<id>/logs/runtime.jsonl`.
These are operator diagnostics, separate from authoritative task events and
worker evidence. Review logs before sharing and preserve their private state
permissions. Startup registers subfactories parent-first and associates each
line with its declared parent. Existing registry drift is reported instead of
silently replacing operator changes.

## Drift and lifecycle

The YAML owns the Factory, subfactory and line IDs declared in its definition.
While the managed system is running, Factory rejects `PATCH` and `DELETE` for
those records with HTTP 409, and its webview identifies them as YAML-managed.
This prevents a registry edit from making the next system start fail its saved
configuration checks. Additional records created independently in Factory remain
editable; registering a line still does not start its orchestrator or workers.

To change the declared topology, stop the owning system and plan a deliberate
migration, or use an updated YAML with a distinct empty state directory for a
separate deployment. Editing the YAML alone does not migrate existing state.
Preserve the original complete state and follow the
[backup procedure](../how-to/upgrade-backup.md); do not delete a registry record
or clear state to bypass drift protection.

Setup preserves existing secrets and identities. An existing state is bound to
its normalized definition and selected environment. Changing that definition is
not an implicit migration: setup/up/start reject drift. Maintenance uses the saved
topology, so status/doctor/stop can inspect or stop the existing processes when
invoked with the exact `--state-dir` and no file. A supplied Docker file must match
the saved definition; native maintenance can use changed YAML with the same system
ID, while still enforcing the environment boundary. A stopped process alone does not
make arbitrary project, port, worker or environment changes compatible with its
persisted identities. Plan a deliberate migration or use a distinct, empty state
for a separate deployment.

On Linux, Docker uses the same on-disk hierarchy in private bind state. Windows
Docker stores that hierarchy in an owned named volume with a host pointer. Use
`./werk-docker.ps1 system credentials --file runtime/examples/system.yaml --environment docker`
to export private login files into a new host `credential-export` directory:
`factory/credentials.json` and `lines/<id>/credentials.json`. The export preserves
current-user-only ACLs, reports paths rather than secrets, and refuses an existing
export directory. Keep the pointer and volume together for backup. If an existing
pointer names a missing volume, the wrappers refuse to recreate it even for
setup/up: restore its backup or deliberately choose a new state directory.

Native state stores the normalized definition in `system.json`, Factory
credentials in `factory/credentials.json` (`WERK_FACTORY_ADMIN_TOKEN`), and each
line's separate credentials in `lines/<id>/credentials.json`
(`WERK_ADMIN_TOKEN`, `WERK_ENROLLMENT_TOKEN`). These are private files; plans and
lifecycle output do not contain their values.

The YAML is input data. Tasks are submitted after startup through the appropriate
line. Credentials stay in private runtime storage and are not printed in plan
output or embedded in browser URLs. The supplied example uses mock execution. The
[system tutorial](../tutorials/system-from-yaml.md) covers login and the first task;
[security](security.md) and [backup](../how-to/upgrade-backup.md) describe the
operating boundaries.

Public browser origins are optional deployment settings, normalized with a trailing
slash. They do not change the private API address used by Factory polling,
bootstrap or workers. Declare them before first setup when enabling TLS ingress;
changing an existing system definition requires a coordinated stopped deployment
migration, not editing the live registry. See [TLS and access](../how-to/manage-access.md).
