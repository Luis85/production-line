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
The runtime mode is always `mock`; `runtime` selects native or Docker deployment,
not a coding provider. Setup preserves valid existing configuration and credentials.
Stop services before a deliberate configuration or deployment change. Existing
worker identities are bound to their connection/configuration: changing ports,
project or worker configuration may require a new worker state and an explicitly
planned migration. A stopped edit is not an automatic identity migration.

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
