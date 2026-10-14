# Develop and test from a source checkout

Three independently deployable Node.js / TypeScript CLI applications, a Factory
hierarchy/line registry, a SQLite orchestrator, configurable workers, a repository importer and measurable mock
execution. Each orchestrator webview opens on its live **line map**; choose **Intake** to submit work. The 3D concept prototype is served
at `/concept`; it deliberately retains separate simulated browser state.

This guide requires the source checkout, Node 24 and npm. For an extracted release with no build step, use the [local first-task tutorial](../tutorials/local-first-task.md) or [Docker tutorial](../tutorials/docker-first-task.md). Developer fleet launchers below retain their separate `.state` directories; release operators use `.werk`.

## What works in this starter

- HTTP and CLI intake, including JSON on stdin and Obsidian wikilinks.
- Import ready features from a committed iteration branch and YAML properties.
- SQLite persistence, project-bound registration, atomic claims and lease checks.
- Multiple processes, configurable machine/profile concurrency and bounded retries.
- Immutable before/after snapshots, local Git-checkout artifact files, a retry
  outbox, server-side SHA-256 indexing and a paginated analysis API.
- A portfolio/health dashboard and a local HTML/JSON status service per worker.
- Three dedicated CLI builds, Dockerfiles, Compose and local one-line/two-line launchers.

**Execution is explicitly mock.** No Claude/Codex CLI is invoked, no code is
implemented, no Git push or real PR/review operation is performed. A mock run
finishes as `simulated`, never `done` or `review`. Provider cost, tokens and
unrun quality checks remain unknown. The full target PR lifecycle is documented
in [docs/architecture.md](../explanation/architecture.md) and simulated in `/concept`.

For the portfolio hierarchy and two independent lines, start with
[Factory setup](factory.md). This guide covers execution inside an individual
line; Factory does not own or reassign its tasks.

## Quick start: one orchestrator and three workers

Prerequisites: Node **24.x**, npm, and Git for iteration import.

```bash
npm ci
npm run build
npm run dev:fleet -- --workers 3
```

Open `http://127.0.0.1:3000/`. The launcher stores generated credentials in
`.state/fleet/credentials.json`. Enter its `WERK_ADMIN_TOKEN` value in the
Intake page. It is kept only in page memory. Worker status pages start at ports
4101, 4102 and 4103. Ctrl+C stops the whole fleet. Existing SQLite data and
worker identities survive a clean restart.

In a second terminal at the project root:

```bash
source .state/fleet/env.sh
node src/orchestrator/dist/orchestrator/cli.js task create \
  --file examples/task.json --key demo-order-export-001
node src/orchestrator/dist/orchestrator/cli.js task list
node src/orchestrator/dist/orchestrator/cli.js workers list
```

For PowerShell, load `. ./.state/fleet/env.ps1` instead of the Bash `source` command.
Both generated environment files set `WERK_URL` to the selected port.

`WERK_DEV_PORT` changes the server port; `WERK_STATUS_BASE` changes the first
worker status port. Each fleet supports 1–50 worker processes. Set `WERK_URL`
for client commands if the server is not on port 3000. The starter's enrollment
grant binds all newly registered workers to `demo` unless `serve --project`
selects another project. Multi-project enrollment grants are a production step;
the store and task protocol already enforce each worker's assigned project.

## Independent applications

| Source | Responsibility | Build result |
| --- | --- | --- |
| `src/factory` | Hierarchy, line registry, portfolio rollups | `src/factory/dist` |
| `src/orchestrator` | CLI, API, webview, SQLite, importer | `src/orchestrator/dist` |
| `src/worker` | CLI, polling, execution, snapshots, status | `src/worker/dist` |
| `src/shared` | Contracts, validation, transport helpers | Copied into each build |

```bash
npm run build --workspace @werk/factory
npm run build --workspace @werk/orchestrator
npm run build --workspace @werk/worker
node src/factory/dist/factory/cli.js --help
node src/orchestrator/dist/orchestrator/cli.js --help
node src/worker/dist/worker/cli.js --help
```

Each `dist` directory can be moved to another machine with Node 24 and run
independently. The orchestrator build includes its YAML parser and web assets;
the worker has no third-party runtime dependency. Workspace packages also
expose `werk-factory`, `werk-orchestrator` and `werk-worker` in npm script/PATH
contexts after install/build. The `node .../cli.js` commands work without a global
installation and are used throughout setup.

The build strips TypeScript using Node's built-in transformer. Static checking
is a separate, required development check: `npm run typecheck`. Node 24 may
emit experimental warnings for SQLite/type stripping; these go to stderr.

## Requirement-note intake

The normal lightweight intake needs only the project and one vault reference:

```text
node src/orchestrator/dist/orchestrator/cli.js task create --project demo --wikilink "[[Features/Customer portal]]" --key portal-001
```

The equivalent JSON is `{"project":"demo","requirementRef":"[[Features/Customer portal]]"}`.
Use `examples/vault-task.json` with `--file` or JSON on stdin. The API derives a
display label from the reference in default unbound mock mode, with no fabricated
acceptance criteria. Operator-bound intake instead resolves a committed ready
note and persists its manifest before queuing; workers verify that context before
mock execution. See [pinned context](../reference/pinned-context.md). Legacy manual intake and
imports remain available on unbound lines. Bound lines support explicit
[pinned iteration import](pinned-iteration-import.md); remote PR identity and live
provider execution remain unimplemented.
Do not combine `--file` with `--project`/`--wikilink`.

## Headless intake

```bash
node src/orchestrator/dist/orchestrator/cli.js task create \
  --file - --key order-export-002 < examples/task.json
node src/orchestrator/dist/orchestrator/cli.js task get --id TASK_ID
node src/orchestrator/dist/orchestrator/cli.js task events --id TASK_ID
node src/orchestrator/dist/orchestrator/cli.js snapshots list --task TASK_ID
```

Exactly one JSON object is read from stdin. A submission key is stable across
retries: same key + same payload returns the same task; a different payload is
rejected with 409. Commands produce JSON on stdout; diagnostics go to stderr.
Exit codes: 0 success, 2 input/API 4xx or an import requiring a revision decision,
1 runtime/network failure. CLI clients call HTTP; they never open the DB file.

## The weekly product-team workflow

The product team maintains requirements, designs, concepts, specs and tests in
its Obsidian project repository. After planning it creates
`iteration/2026-W42` and an iteration **draft PR targeting main**. Ready features
use the properties in [examples/feature.md](../../examples/feature.md).

```bash
node src/orchestrator/dist/orchestrator/cli.js iteration import \
  --repo /path/to/project \
  --branch iteration/2026-W42 \
  --project demo --iteration 2026-W42 \
  --iteration-pr https://git.example/team/project/pull/10 \
  --features docs/features --dry-run true
```

Remove `--dry-run true` to submit. Create or update the intended local branch before importing (a remote-tracking
ref alone is not enough);
the command reads Git objects, ignores uncommitted changes and never fetches,
checks out, commits or pushes. Only `factory_status: ready_for_implementation`
with the requested `factory_iteration` is imported. Duplicate feature IDs and
malformed YAML fail validation before submission. YAML aliases are bounded.

Re-running skips unchanged feature notes. Changed imported notes report
`revision_required`; the starter does not silently change an active task's
specification. Imports are resumable per feature, not one cross-feature atomic
transaction. A feature removed from the ready set is not automatically canceled.
Manual intake is retained for exceptions; repository import is the normal route.

## Configure a worker

```bash
node src/worker/dist/worker/cli.js run \
  --config examples/worker.json \
  --state-dir .state/custom-worker --status-port 4201
```

Set `WERK_ENROLLMENT_TOKEN` and optionally `WERK_URL` first. Configuration covers:

- Serial execution (`maxParallel: 1`) across chat, local file tasks and remote
  assignments; priority or FIFO order, polling interval, and a 1–5 attempt ceiling.
- Execution timeout and mock duration.
- A worker system prompt. In mock mode its hash is recorded; no model consumes it.
- Multiple Claude/Codex profiles, each with a limit of one. Profiles share the
  worker’s single execution slot; start separate workers for parallel work.

Flags override config values where available (`--parallel`, `--profiles`,
`--poll-ms`, `--mock-ms`, `--timeout-ms`). The effective configuration is hashed
and bound to the worker identity and every attempt. No hot edits to active runs:
finish or stop the worker, then use a new state directory for changed settings.
The server independently enforces slot limits. Live quota-group enforcement and
production enrollment policy are still future integrations.

```bash
node src/worker/dist/worker/cli.js status --url http://127.0.0.1:4201
node src/worker/dist/worker/cli.js status \
  --url http://127.0.0.1:4201 --format html > worker-status.html
```

The exported HTML is a standalone frozen snapshot. The live `/` page refreshes
every 3 seconds. Status listens on loopback by default; it is read-only and
excludes tokens, system-prompt contents and repository content.

## Worker snapshots and repository artifacts

Every normal execution captures `before.json` before the mock adapter starts
and `after.json` after it terminates. Completion is refused without both. Files
are retained in the worker state directory; pending transfers live in an outbox.
To also write them into an existing project Git checkout:

```bash
node src/worker/dist/worker/cli.js run \
  --config examples/worker.json --state-dir .state/repo-worker \
  --status-port 4202 --project-dir /path/to/project
```

They appear under:

```text
.factory/runs/TASK_ID/attempt-N/LEASE_ID/before.json
.factory/runs/TASK_ID/attempt-N/LEASE_ID/after.json
```

The starter writes these files but does **not** commit/push them. In the target
workflow the worker submits code plus snapshots to a lease-checked publisher,
which pushes them to the same feature PR. See [docs/snapshots.md](../explanation/snapshots.md)
for attribution, crash recovery, data gaps, cost semantics and PR provenance.

## Docker

```bash
node scripts/init-env.mjs
docker compose up --build -d --scale worker=3
docker compose ps
docker compose port --index 1 worker 4100
docker compose logs -f orchestrator worker
docker compose stop
docker compose start
```

The init command creates random, separate tokens and refuses to overwrite an
existing `.env`. Server: `127.0.0.1:3000`. Each worker gets its own anonymous
state volume and dynamically allocated loopback host port. No fixed container
name or shared worker state directory prevents scaling. Containers run non-root,
with read-only root filesystems, healthchecks and graceful stop settings.

Only the orchestrator mounts the named SQLite volume. Do not scale it above
one replica and do not put its DB on NFS. No PostgreSQL/Redis service is needed.
Test-worker identities survive container restarts, but anonymous volumes are
not a stable identity strategy after `down`/recreation. For long-lived workers
define separate services with distinct named volumes. Never share provider
credential directories between replicas. Real CLI binaries/auth are deliberately
absent from the mock image; add them only with the corresponding tested adapter.

To change Docker worker config, mount a config file read-only and pass
`--config /config/worker.json` in its `command`. Keep state volume per worker.
For production, replace development environment-token distribution with managed
secrets, per-project enrollment and TLS/reverse-proxy policy.

## Operations and verification

- Back up SQLite with the server stopped: `docker compose stop`, then
  `docker compose cp orchestrator:/data ./backups/factory-data`. Keep the complete
  directory together. Restart with `docker compose start`. Restore the directory
  into an empty server data volume with the same application/schema version and
  UID permissions. Worker identities and journals need their own backups.
- Graceful termination cancels tasks, records interrupted snapshots and releases
  valid leases. If the server is unreachable, the outbox remains and leases expire.
- After a hard crash, verify the old worker process is gone, remove only its
  `worker.lock`, then restart with the same state/config. Incomplete snapshot pairs
  are completed with an explicitly recovered interruption record. Exact missing
  duration/CPU attribution stays unknown. Never delete a lock for a live process.
- Failed/expired runs stop at the configured attempt ceiling (`blocked`). The
  starter has no task-revision/unblock endpoint; investigate and submit a new
  explicitly identified task instead of silently replaying a blocked attempt.
- Expired leases are reconciled by a background sweep and on relevant reads.
  The attempt ceiling is pinned when assigned, so later worker changes cannot
  silently extend an in-flight task's retry budget.

```bash
npm run typecheck
npm test
```

Tests cover intake, idempotency, routing, lease fencing, snapshot gates,
persistence, multi-process execution, configuration, import and recovery.
Node tests and TypeScript checking were run during delivery. Container verification is recorded per run in the [review reports](../reports/index.md); source checks alone do not qualify a deployment.
Runtime pagination and authentication journeys also have desktop/mobile Chromium fixture evidence; see [pass 3 review](../reports/pass3-review.md). These checks do not replace live deployment acceptance.

See [operations.md](operations.md) for fleet locks, ordered shutdown, Docker
identity persistence and backup/restore details.

Interface reference: [docs/api.md](../reference/api.md). Architecture and remaining
integration boundaries: [docs/architecture.md](../explanation/architecture.md).

Source modules and test suites are grouped by concern. See the [architecture map](../explanation/architecture.md#implemented-dependency-map) and [test suite guide](../../tests/README.md). The project test command uses Node 24 recursive glob discovery for both `.test.mjs` and `.test.cjs`.

## Shared browser interfaces

All product views use Vue and Nuxt UI. Read the [webview architecture](../reference/webview-architecture.md) before adding shared components or changing browser state. The unified typecheck covers every entry; independent app builds include their own compiled assets and standalone guide/export views.
