# Operate source-checkout fleets

This guide covers the developer fleet launchers and source Compose files. For the extracted release operator and its `.werk` state, use [maintain the runtime](maintain-runtime.md) and [upgrade, back up and restore](upgrade-backup.md).

## Local fleet

The launcher owns `.state/fleet/fleet.lock`. It refuses a second fleet using the
same state and checks every requested port before creating server/worker
processes. CLI entry points must already be built. Generated secrets are reused;
invalid existing credentials fail startup instead of silently rotating tokens
and making persisted workers inaccessible.

Child processes receive only explicitly selected Werk credentials. Inherited
Factory/line token variables are removed, and workers receive enrollment only.

The launcher writes `env.sh` and `env.ps1` with credentials and the current server
URL on every start. Load one in the terminal where you run headless commands.
Do not commit these files. File modes restrict access on POSIX systems; on Windows
apply appropriate directory ACLs to `.state` for the account running the fleet.
If PowerShell execution policy blocks dot-sourcing, read the generated JSON into
process environment variables without changing machine policy:

```powershell
$werkCredentials = Get-Content ./.state/fleet/credentials.json -Raw | ConvertFrom-Json
$env:WERK_ADMIN_TOKEN = $werkCredentials.WERK_ADMIN_TOKEN
$env:WERK_ENROLLMENT_TOKEN = $werkCredentials.WERK_ENROLLMENT_TOKEN
$env:WERK_URL = 'http://127.0.0.1:3000'
```

For alternative ports:

```bash
WERK_DEV_PORT=3100 WERK_STATUS_BASE=4201 npm run dev:fleet -- --workers 5
```

```powershell
$env:WERK_DEV_PORT = '3100'
$env:WERK_STATUS_BASE = '4201'
npm run dev:fleet -- --workers 5
```

The launcher handles Ctrl+C/SIGTERM, stops workers first, then the server. After
15 seconds it force-stops surviving children; unflushed evidence then relies on
journal recovery and lease expiry. Unexpected child exit stops the whole fleet
and returns a failure exit code. This launcher supervises mock Node processes;
future coding-agent adapters must also manage their subprocess groups.

After a crash, first verify **all** old server/worker processes are stopped.
Remove the stale fleet lock and affected worker locks only after that check.
Keep credentials, SQLite files and journals. A changed worker configuration
requires a fresh worker state directory; do not delete its identity to bypass a
live lease. Never run two workers on one state directory.

## Docker deployment

Run all Compose commands at the repository root. `node scripts/init-env.mjs`
creates `.env` once and refuses to overwrite it. Preserve this file with the
server data: arbitrary secret rotation does not migrate existing worker identity.

Only the orchestrator mounts the named `factory-data` volume. Run exactly one
orchestrator; SQLite WAL must remain on local storage, not a shared network drive.
Workers communicate over HTTP and never mount the SQLite file. Containers are
non-root, have a read-only root filesystem, writable `/data` and `/tmp`, dropped
capabilities, healthchecks and an init process for child reaping.

`docker compose up --build -d --scale worker=3` is the disposable test-fleet
setup. Anonymous worker volumes isolate identity and journals per replica and
survive stop/start. After `down`/recreation, those volumes are not automatically a
stable identity mapping. For persistent workers, define one explicitly named
service per worker with its own named volume; use a Compose override, remove the
scaled `worker` service from that deployment, and do not share `/data`.

Inspect a worker's host port with `docker compose port --index 1 worker 4100`.
Server and worker host ports bind to loopback. A reverse proxy/TLS and per-project
access policy are required before exposing the service beyond the host. The
worker status endpoint is read-only and has no login; keep it on trusted local
interfaces. HTTP process health is distinct from provider/connection health.

Docker builds use a mutable Node 24 Debian image tag; npm dependencies use the
committed lockfile. For controlled deployments, pin all three Dockerfiles' base images
to a reviewed digest and rebuild regularly. The Dockerfiles include no real
Claude/Codex binaries or provider credentials. A tested provider adapter must
supply these; use distinct local credential directories for separate identities.

A worker config mount can be added in an override:

```yaml
services:
  worker:
    volumes:
      - ./examples/worker.json:/config/worker.json:ro
    command: ["run", "--config", "/config/worker.json", "--state-dir", "/data", "--status-host", "0.0.0.0", "--status-port", "4100"]
```

Compose stop order follows service dependencies, allowing workers to finish
reporting before the server stops. The application has bounded retries; when the
server is unreachable, snapshots remain in the worker outbox for a later restart.

## Backup and restore

1. Stop writers with `docker compose stop` (or stop the local fleet).
2. Copy the complete server `/data` directory, including any SQLite WAL/SHM files:
   `docker compose cp orchestrator:/data ./backups/factory-data`.
3. Back up worker state directories separately: identity, snapshots and pending
   outbox entries are needed for recovery. Preserve `.env`/local credentials with
   restricted access alongside the backup.
4. Restart with `docker compose start`. Do not copy only a live `.sqlite` file.

Restore into an empty server data volume with the application version that made
the backup and the correct Node-user ownership. Keep the original backup intact.
Start one server, verify `/healthz` and task/snapshot reads, then restore workers
with their original configuration. Never roll back only the DB while current
workers continue publishing against a newer task history. Schema migrations run
on startup; do not point an older binary at a newer database schema.

### Restore verification

`node --test tests/operations/backup-restore.test.mjs` (after `npm run build`) rehearses the stopped-writer copy procedure using real independent Factory and line databases plus a worker snapshot journal. It restores into a new directory, preserves credential identity and intake/claim idempotency, replays pending evidence, verifies one terminal event, checks SQLite integrity and confirms the preserved backup database hash.

This qualifies the local store/journal boundaries. It does not qualify live volume copies, provider sessions, full HTTP fleet restart, cloud storage or a deployment recovery-time objective. Stop all writers and preserve credentials as described above.

## Failure diagnosis

| Symptom | Action |
| --- | --- |
| Port unavailable | Stop conflicting process or choose different server/status ports |
| Fleet/worker lock exists | Verify old processes are gone before removing the specific lock |
| 401 / enrollment fails | Check the server URL, distinct admin/enrollment tokens and preserved worker identity |
| No assignment | Check project binding, requested provider, profile slots and queued tasks |
| Running task after worker loss | Wait for lease expiry; server reconciliation returns it to queue or blocks at its pinned attempt ceiling |
| Missing after snapshot | Restore that worker's journal; recovered records remain explicitly interrupted with unknown lost measurements |
| Blocked task | Investigate attempt history; no unblock/revision API exists in this starter |
| Cost/quality shows unknown | Expected for mock execution; do not treat missing data as zero or passed checks |

Review `/v1/tasks/:id/events`, worker status, snapshots and process logs together.
The portfolio is analytical evidence, not a substitute for CI or human acceptance.

## Factory hierarchy operations

The Factory registry has its own database and backups. Its records point to
independent orchestrator lines; backing up Factory does not back up any line's
tasks or worker evidence. Preserve the Factory registry, each orchestrator
database, each worker state directory and the separate secret mappings according
to the same stopped-writer procedure. Restore each with compatible schemas.
A deleted line registration does not delete the line's data or stop its workers.

The local `dev:factory` launcher uses `.state/factory-fleet`, a separate lock,
credentials and per-line state. It shuts down workers, then lines, then Factory.
The Docker overlay uses its own Factory registry volume plus distinct line
volumes. Factory logical hierarchy does not implement cross-server federation,
HA or disaster recovery coordination. See [Factory setup](factory.md).
