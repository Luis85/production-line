# Twelve-Factor and portable VM audit

Date: 2026-10-12. Scope: source and operating-contract review of the packaged
Factory, orchestrator, worker and native/Docker system launchers. This report does
not establish cloud-provider deployment, Windows execution or live provider work.
Execution remains simulated.

## Architectural conclusion

The current runtime is a stateful, single-writer application suitable for a
bounded single-VM deployment with protected persistent storage. Moving SQLite,
worker identities and the durable outbox outside the release directory separates
code from data; it does not make the processes stateless or turn the files into
attachable backing services. Do not replicate Factory/orchestrator processes
against the same state, share worker identity directories or advertise HA.

The [Twelve-Factor explanation](../explanation/twelve-factor.md) is the maintained
operating guidance. This dated review records the baseline and its limitations;
new environment, stream-logging and VM-renderer work needs its own integration
validation.

## Factor-by-factor assessment

| Factor | Evidence and remaining constraint |
| --- | --- |
| I. Codebase | One repository builds three independent role distributions; release identity should remain pinned to an immutable artifact. |
| II. Dependencies | npm lock and bundled YAML dependency avoid runtime installation. Native Node remains an explicit dependency; Docker's base tag alone is mutable. Pin and verify deployment artifacts. |
| III. Config | Tokens are injected through environment/private storage; several deployment settings use flags/files. Environment support must have explicit precedence, validation and no credentials in user-data, command arguments or URLs. |
| IV. Backing services | Role communication uses HTTP. SQLite databases and filesystem journals remain embedded storage, not swappable network services. |
| V. Build, release, run | Archives contain precompiled applications. Provisioning should acquire/build once; a VM service restart must start that verified release without rebuilding or downloading mutable code. |
| VI. Processes | Durable databases, worker identity and outbox persist beyond a process lifetime. Stateless process compliance is not established. |
| VII. Port binding | Roles own their HTTP listeners. Loopback plus SSH forwarding provides a minimal private VM access profile; public ingress is a separate deployment design. |
| VIII. Concurrency | Independent workers and lines are supported. Arbitrary Factory/orchestrator replica scaling and shared identity directories are unsupported. |
| IX. Disposability | Cooperative TERM handling, leases and bounded server shutdown support orderly replacement. Abrupt death can retain runtime/worker locks and requires verified recovery. |
| X. Dev/prod parity | The packaged runtime can be used in development and on a VM. Matching mock execution is not evidence of real provider operation. |
| XI. Logs | Services emit structured stream diagnostics. Native supervisors additionally own rotating files; a VM journal profile must forward nested line/worker events and validate the selected sink. |
| XII. Admin processes | Packaged authenticated API/CLI commands provide one-off operations. Backups and schema-changing operations must respect exclusive ownership of the same state and release. |

## Minimum credible VM profile

Use a dedicated nonroot operating account, a checksum-verified immutable release,
a declared Node 24 runtime, private persistent local/block-backed storage, and one
owning systemd service per system state. Keep the application on loopback and use
SSH forwarding for operator access. A firewall or cloud security policy should
allow only the intended administration path. Generate credentials locally in
protected state or provide protected credential files; cloud-init user-data is
not secret storage.

Give the owning supervisor enough stop time for its ordered worker/line/Factory
shutdown. Keep its descendants in the service cgroup and bound the final kill.
Health checks must distinguish a running supervisor from authenticated ready
services. Restart policies do not themselves repair stale ownership metadata.
Never remove locks merely because a restart failed.

Back up the complete stopped state, preserving credentials, identities, SQLite
files and worker evidence. Restore to one replacement owner, check readiness and
retained task/worker identity, and keep the prior release and backup for rollback.
A copied state directory must not be used for a concurrent second writer.

## Concrete shutdown fix and evidence

The review found that worker shutdown waited indefinitely for an unfinished
status HTTP request before releasing `worker.lock`. The
[worker runner](../../src/worker/runner.ts) now closes remaining status connections
after five seconds, before the native worker supervisor's twelve-second grace
expires.

The [POSIX shutdown regression](../../tests/worker/worker-shutdown.test.mjs)
starts a real worker child, sends an incomplete HTTP header, delivers SIGTERM,
and verifies normal exit, lock removal, unchanged identity and successful restart.
The isolated fixture failed without the fix at its 7.5-second deadline and passed
with the fix in approximately six seconds. Type checking passed. This test uses
POSIX signal semantics and explicitly skips Windows; it does not verify host-loss
recovery or arbitrary provider cancellation. Shared distributions were not rebuilt
for this focused test and must include the source change in final integration.

## Work that requires an architectural change

Stateless control-plane replicas require external transactional persistence with
appropriate concurrency, lease and migration semantics. The same database may
also implement the queue; a separate broker is not automatically required.
Disposable workers require external durable evidence/outbox storage or a replay
and identity design that remains correct without the worker's original disk.
Cloud-init, a mounted volume and restart policies cannot substitute for these
changes.

## Independent cloud-init source review

The [renderer](../../scripts/infrastructure/cloud-init.mjs) and
[installer](../../scripts/infrastructure/provision.py) were reviewed after the
initial findings were addressed. Deferred file creation now follows user/group
creation; the profile includes Git; first boot waits for authenticated doctor
success with a running supervisor rather than accepting systemd process creation
as readiness. The installer verifies pinned artifact digests before bounded
manual extraction, selects only Node's binary and license, checks the release
manifest, and starts the read-only release under the dedicated operating account.
The rendered configuration contains no application credentials.

Installed version directories and state are retained after failure. Provisioning
refuses an existing version rather than silently repairing or replacing it;
interrupted installation therefore requires inspection and the documented
maintenance procedure. The review found no further source-level runtime blockers
in those corrected paths. A local render was parsed successfully; this is not a
cloud-init execution or cloud-provider VM boot qualification.
