# Operate, back up and replace a Linux VM

This procedure is for the native Ubuntu 24.04 cloud-init profile described in the
[VM tutorial](../tutorials/linux-vm-first-task.md). It does not convert a Docker
state directory or create a highly available cluster. Keep administrative access
on SSH and loopback; do not open Factory, orchestrator or worker ports to the
public network as a shortcut.

## Observe before restarting

Inspect the generated service and its journal:

```text
sudo systemctl status werk-system.service
sudo journalctl -u werk-system.service --no-pager -n 100
```

Use systemd status and the journal to distinguish a supervisor failure from an
unready worker. Use the release operator's status/doctor commands with the same
system definition and state directory as the service. A running systemd process
alone does not establish whole-system readiness. Worker `/status` remains useful
for diagnosis even when its `/healthz` returns 503.

The [monitoring guide](monitor-runtime.md) explains capability observations,
request IDs and task evidence. The VM profile sends structured logs to the process
stream for journald; configure journal retention/access and any remote collector
as separate host operations. Stream mode does not promise a local runtime log
file. Never include credentials, backups or raw task input in incident reports.

## Take a stopped-state backup

1. Pause task submission and arrange an administrative maintenance window.
2. Run `sudo systemctl stop werk-system.service`. Wait for it to become inactive
   (`systemctl is-active werk-system.service`) and verify no
   Werk child processes still write to its state. Graceful shutdown is bounded;
   check logs for failure rather than assuming every pending attempt finished.
   An abrupt host loss or SIGKILL can leave a worker lock requiring verified
   recovery; never delete a lock without establishing that its owner is stopped.
3. Back up all of `/var/lib/werk`, preserving ownership and restrictive modes:
   Factory database/credentials, every line database and SQLite sidecars, all
   worker identities, pending journals, snapshots and configuration. Keep the
   `/etc/werk` topology/environment files, release inventory, artifact hashes and service unit with
   the backup record.
4. Encrypt/store the backup privately off the VM. It contains reusable credentials
   and task/source evidence. Copying a live SQLite file or only the Factory
   database is not this backup procedure.
5. Use `sudo systemctl start werk-system.service` only if it will remain the sole owner. Confirm
   health, worker identity continuity and task history before resuming intake.

The native [verified maintenance commands](upgrade-backup.md#verified-native-maintenance-commands) automate a private full-state copy, checksum verification and restoration into a new path. Run them as `werk` after stopping the service; retain `/etc/werk`, the unit and artifact inventory separately. For example, use the installed Node and release paths from the unit to run `werk.mjs maintenance backup --state-dir /var/lib/werk --to /private-backups/werk-before-upgrade --json`. Ensure the backup parent is private and writable by `werk`.

A filesystem or volume snapshot taken after all writers stop can be part of this
procedure. A provider snapshot advertised as crash-consistent is not evidence of
an application-consistent restore. Test restoration with the matching release;
record measured recovery times instead of promising an untested RTO/RPO.

## Recover an interrupted installation

The first-boot installer refuses existing versioned Node or release directories.
A failed installation after those directories were placed cannot be repaired by
blindly rerunning cloud-init. The initial authenticated readiness check has a
120-second deadline; failure attempts a service stop and preserves installation
and state. Confirm actual service/process state before recovery, including whether
an enabled unit could restart on reboot. Inspect cloud-init diagnostics, the installed artifact
inventory, service state and `/var/lib/werk` first. Preserve any generated
credentials, task history and worker evidence. Choose a deliberate recovery or
fresh VM installation; do not automatically delete the state directory to make
setup pass.

For a persistent data disk, mount it at a separate host mount point and arrange a
bind mount of an **empty dedicated subdirectory** at `/var/lib/werk` before
provisioning. A freshly formatted filesystem mounted directly there can contain
`lost+found`; that is not an empty Werk state directory and setup rejects it.
Ensure the mount is present before every service start, owned by the `werk`
account and mode 0700; do not allow an absent disk to fall back silently to a new
local state directory. Cloud-init does not create or manage that disk/mount policy.

## Upgrade programs separately from state

Obtain and authenticate the new release, verify its exact SHA-256, and extract it
into a new versioned directory. Take a stopped-state backup before switching the
systemd service to that release. Preserve the external state directory, topology
and ownership; use the same Node/runtime compatibility contract.

Review migrations and compatibility for the particular release. A manifest
records files, not database downgrade safety. Start the new release, verify
whole-system readiness, authenticate to Factory and each affected line, and
inspect existing task history and worker identities. Keep the old release and
untouched backup until this validation passes. Cloud-init render is an install
artifact generator, not an unattended updater or database migration engine.

## Replace a VM without creating two writers

Prepare the replacement OS and verify the same release/Node artifacts. Keep its
Werk service stopped while restoring a compatible backup into the correct
private state location. Restore the matching definition and service configuration;
check account ownership and restrictive permissions before starting.

Keep the old VM stopped throughout the restore and acceptance test. Do not attach
one writable state volume to two active Werk deployments. Once the replacement
passes readiness and continuity checks, update your SSH destination or other
operator-controlled access path. Retain the old VM/backup under your retention
policy without allowing its service to restart against the migrated state.

If initial provisioning already generated a new identity/history, do not merge
that state with the backup. Stop it and deliberately restore into an empty state
location after preserving any evidence that must be retained. The renderer does
not automate restoring or reconciling two installations.

## Roll back with compatible state

Stop every newer writer. Restore the original complete backup into an empty
private state directory and select the release that created it. Do not start an
older binary against a database modified by a newer release. Recheck readiness,
authentication, task history and worker journals before resuming intake.

See [general upgrade/backup guidance](upgrade-backup.md) and
[the stateful architecture](../explanation/twelve-factor.md). These are operating
procedures requiring operator execution and verification; no actual cloud VM
boot, provider snapshot restore or production failover has been verified here.
