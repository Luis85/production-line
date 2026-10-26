# Why the runtime has separate services

A Werk line consists of an orchestrator and workers. The orchestrator owns its
SQLite state, task intake, scheduling, leases and accepted evidence. Workers own
execution attempts, local identities and recovery journals. They communicate
through authenticated HTTP, so a worker never needs the database file.

The [system operator](../reference/system-definition.md) starts a Factory and its
independent production lines from one YAML definition. Optional subfactories are
logical branches in one Factory registry; they add no server process or database.
See [core entities](core-entities.md) for the model and the view owned by each entity.

The single-line release operator starts its orchestrator and workers together for convenience.
It supervises their lifecycle and waits for readiness; it does not merge their
state ownership. Stopping workers before the orchestrator gives pending evidence
a chance to flush. Abrupt interruption still requires journal and lease recovery.

Factory is an optional portfolio service above independent lines. It has its own
registry/database and aggregates line reports, including explicit partial results
when a line is unavailable. It is not a central task queue and does not provide
high availability or cross-server federation. The first-task tutorials deliberately
start one line without requiring a Factory hierarchy.

## Programs and data have different lifetimes

The central WerkHome has stable root launchers and documentation, a replaceable
unversioned `runtime/` payload, visible Git repositories in `projects/`, and private
credentials/journals/worktrees in `state/`. Fresh worker state is `state/worker`.
The archive name identifies a version; its entries extract directly into Home.
A runtime update must not treat projects or changing private state as payload.
Keeping those lifetimes separate does not make live state copies consistent.

Legacy standalone Home adoption explicitly selects an original absolute state
path without moving it. Project-installed state depends on external startup
configuration and is refused for central adoption; its matching old runtime is
needed for recovery/export. Existing retained paths stay significant after adoption.

Native and Docker launchers share the versioned setup format. The configuration
records which runtime owns it so the other launcher cannot silently reuse it.
Their process and filesystem mappings differ; switching runtimes therefore needs
a planned stopped-state migration, not a different start command.

The complete application `dist` directories are independently deployable. Source
checkout fleet scripts and Factory examples remain developer workflows with their
own state conventions. They are not prerequisites for using the release.

See [configuration](../reference/configuration.md) for exact state fields,
[runtime CLI](../reference/runtime-cli.md) for lifecycle commands and
[upgrade/backup](../how-to/upgrade-backup.md) for safe maintenance.
