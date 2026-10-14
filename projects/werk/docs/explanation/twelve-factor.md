# Twelve-factor principles and Werk's stateful boundary

Werk adopts useful parts of the [twelve-factor methodology](https://12factor.net/),
but it is not a stateless, horizontally replicated application. Each orchestrator
and the Factory own SQLite databases. Workers retain enrolled identities,
snapshots and durable pending evidence. Those files survive process replacement;
losing them is not equivalent to restarting a disposable HTTP process.

The portable VM profile deploys one native mock system on an Ubuntu 24.04 Linux
VM. It separates verified release files from private persistent state and uses a
non-root systemd service. It does not supply a managed database, shared-disk
coordination, automatic failover or a multi-node control plane. Cloud-init is
portable installation input, not evidence that a particular provider or VM image
has been boot-tested.

## What maps to the twelve factors

| Factor | Current behavior and boundary |
| --- | --- |
| I. Codebase | The source checkout builds independently packaged Factory, orchestrator and worker distributions. Release metadata records a source revision when available. |
| II. Dependencies | Source dependencies are locked; runtime archives carry prebuilt applications. The VM profile verifies explicit Werk and Node artifact hashes. Host tools and the selected OS remain deployment dependencies. |
| III. Configuration | Topology is nonsecret YAML. Documented operator environment variables provide deployment defaults with matching CLI precedence; saved worker settings have their own precedence. The local execution deadline has an explicit authoritative environment override. Credentials stay in private runtime files, outside the release. |
| IV. Backing services | Services communicate through authenticated HTTP, but persistence is local SQLite and worker files. There is no interchangeable remote-database adapter or external queue. |
| V. Build, release, run | Compile/package before deployment; install a verified version separately from mutable state. Starting the VM service does not compile the project. Upgrade compatibility remains an operator decision. |
| VI. Processes | HTTP services can restart, but the system depends on durable local state. It does not satisfy strict stateless-process assumptions. |
| VII. Port binding | Services expose configured loopback ports. VM access uses SSH forwarding; exposing public listeners requires a separately designed authentication/TLS boundary. |
| VIII. Concurrency | YAML configures multiple isolated lines and worker process slots. This is not permission to run multiple writers against one state directory or to autoscale copies of a worker identity. |
| IX. Disposability | Graceful shutdown stops workers before servers and permits pending evidence to settle. Abrupt termination still relies on lease/journal recovery; a timeout is not proof that all evidence reached the server. |
| X. Dev/prod parity | Local and VM native paths consume the same runtime distributions and topology model. Provider images, systemd and actual VM networking still require deployment-specific validation. |
| XI. Logs | Structured bounded diagnostics can stream to the supervisor's environment. Worker resource alert transitions also enter the structured stream; the separate bounded alert journal supports application polling. Local rotation is optional; journald/collector retention and access remain operator responsibilities. Logs are not the task/evidence database. |
| XII. Admin processes | One-shot plan/status/doctor/stop commands use the same release and state contract. Project integration plan/sync commands review fixed templates and require a matching plan before replacement. Backup, restoration and deliberate migration are separate controlled procedures. |

See [configuration](../reference/configuration.md) for environment precedence and
[observability](../reference/observability.md) for event framing. The
[infrastructure reference](../reference/infrastructure.md) specifies what the
renderer creates and what remains outside its scope.

## State outlives a machine, but it has one owner

A system state backup must include the Factory registry, every line database and
credentials, and every worker journal/identity. Copying only server SQLite files
can discard unsent evidence or create mismatched identities. A live directory
copy is not an application-consistent backup.

Stop all writers before copying state. When moving to a replacement VM, keep the
old service stopped until the replacement is accepted; do not mount and start the
same state on both. Separate lines have separate stores, but each store still has
one active owning deployment. Rollback requires a compatible stopped-state backup
and the release that created it, not merely changing the executable symlink.

SQLite and durable worker outboxes are intentional parts of the current recovery
model. Achieving strict statelessness or high availability would require explicit
persistence, concurrency and recovery redesign, with new behavioral evidence.
Changing configuration variables or putting the processes in containers does not
provide those properties.

The managed VM profile remains mock. A task ending as `simulated` proves the
configured intake/scheduling/evidence journey. Opt-in trusted native Linux Codex
execution produces a local patch in `review`; it does not establish test results,
human approval, publication or merge. See [the live workflow](../how-to/run-codex-task.md). The
[VM tutorial](../tutorials/linux-vm-first-task.md) and
[VM operations guide](../how-to/operate-linux-vm.md) preserve that boundary.

## Long-running worker implementation

The local worker uses one serial execution slot and an explicit per-invocation
budget (six hours by default, at most 24 hours). HTTP provider adapters share the
invocation cancellation signal and avoid hidden five-minute response deadlines;
the initial connection deadline remains bounded. Provider CLIs keep their own
external limits. This is support for long-running calls, not evidence that every
provider has been exercised for hours.

Shutdown stops the resource sampler, drains the in-flight sample and closes
durable journals. Completed model results are checkpointed before presentation;
uncertain interrupted calls require deliberate continuation. Private interaction
state, prompts and answers survive process replacement. Do not run replicas over
the same state directory or clone an enrolled worker identity for concurrency.

Monitoring distinguishes readiness, process resource pressure and model usage.
Worker RSS/heap/CPU exclude child processes; disk covers the state filesystem.
Absent measurements remain unknown, warnings do not restart or cancel work, and
non-streaming silence does not establish a hung model. Alert history retains
1,000 transitions with explicit cursor gaps; external log retention is a separate
operator responsibility.

Project integrations are one-shot administration over three allowlisted files.
They preserve user edits, reject unsafe file types and use reviewed content hashes
under an exclusive lock. They do not edit authentication, permission rules or
agent configuration. Prebuilt archives include required runtime dependencies and
use the same integration and monitoring implementation in native and Docker
journeys. See [project integration](../how-to/project-agent-integrations.md) and
[long-running operations](../how-to/monitor-long-running-worker.md).
