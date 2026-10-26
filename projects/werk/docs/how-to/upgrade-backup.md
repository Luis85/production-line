# Upgrade, back up and restore

Native downloaded releases from 0.2.0 onward provide [automatic startup updates](../reference/updates.md), with verified downloads, stopped-state backups and retained previous releases. Use `node werk.mjs update check` to inspect availability and `update disable` to opt out. Running systems are not restarted by a background timer.

For the central worker, keep a verified stopped-state backup and use root
`worker.mjs update plan --from VERIFIED_CANDIDATE_HOME`, then apply that exact
plan with `--if-match PLAN_ID` and explicit `--stop` if needed. Runtime/root/docs
are replaceable payload; visible projects and private state are not archive
replacement targets. Never extract over a populated Home. Legacy 0.16 standalone
state requires [explicit adoption](project-worker.md#existing-standalone-installations)
without relocation; project-installed state needs its old runtime for recovery.

For a failed Home runtime swap, follow [interrupted Home update recovery](../reference/updates.md#recover-an-interrupted-home-update). Inspect updater locks, reserved state locks and foreground component leases; verify dead matching ownership before removing only abandoned records. If the active runtime is missing, use a separate verified candidate launcher with `update status --home ACTIVE_HOME` then `update rollback --home ACTIVE_HOME`.

The procedures below cover the separate Factory/line operator's manual adoption
from 0.1.0, Docker/VM upgrades and backup recovery. Its older installer/version
selection conventions do not describe central Home worker installation. Keep a
working old release and verified backup. See [release contents](../reference/releases.md).

## Verified native maintenance commands

For a native line or complete native YAML system, stop its owning launcher first.
The default `node werk.mjs up` system stores its complete state under
`.werk-system/demo-system` in the installed release; a custom YAML uses its own
system ID. A single line started with `node werk.mjs start` uses `.werk`. If you
selected `--state-dir`, use that exact directory instead. The paths below are
placeholders for the complete state directory, not just its Factory or one line.

Disable external restart automation for the maintenance window (on the VM, stop
`werk-system.service`). Run these commands as the account that owns the state:

```text
node werk.mjs maintenance diagnose --state-dir /private/werk-state --json
node werk.mjs maintenance backup --state-dir /private/werk-state --to /private/backups/werk-before-upgrade --json
node werk.mjs maintenance verify --from /private/backups/werk-before-upgrade --json
node werk.mjs maintenance restore --from /private/backups/werk-before-upgrade --to /private/werk-restored --json
```

Create the private parent backup directory beforehand. Backup and restore require
new destinations: they never overwrite existing directories. The backup contains
`manifest.json` and `state/`, with SHA-256 and size for every regular state file.
The command holds runtime/setup/worker locks while copying, checks configured
ports are unused, and refuses unknown owners, symlinks, special files and
unresolved ownership records. This coordinates supported launchers; stop any
manually launched writer or external process before running it. A port check
alone cannot prove that an arbitrary process has closed its database.

Credentials, security principals, identity files, databases, WAL/SHM sidecars,
snapshots and pending evidence are preserved. Copies use private directories
(0700) and files (0600); on Windows, also protect the parent directory's ACL.
Limits are 10,000 files, 32 directory levels, 2 GiB per file and 8 GiB total.
Larger installations need a verified stopped-volume backup procedure. Empty
directories are recreated by the runtime as needed. No archive extraction or
remote upload happens, and no credentials are printed. Checksums detect damage;
they do not authenticate a backup from an untrusted party. Store the reported
manifest checksum separately and retain encrypted off-host copies.

Use the matching release to start the restored state, keep the original stopped,
and run `doctor`. Verify the same task IDs, history, snapshots and worker IDs
before resuming intake. A tested local fixture restores a completed mock task
and its worker identity; a separate pending-evidence fixture proves replay does
not duplicate completion. This is not evidence of VM failover or a measured RTO.
Automated maintenance commands reject Docker state and volume pointers; use the
Docker procedure below for both volume contents and matching configuration.

## Preserve assigned repositories and task worktrees

The maintenance and automatic-update backups cover the selected runtime state
directory. They do not include assigned Git checkouts or task worktrees outside
that directory. State records can refer to those retained paths; restoring state
alone cannot recover their files.

Stop the worker and any other process that can write the assigned repositories.
Keep a separate private filesystem backup of each complete checkout, including
its `.werk/worktrees`, uncommitted files, and Git metadata. With
`repositories.worktreeDirectory`, also back up that folder. If the checkout uses
a `.git` file, also preserve the actual common Git directory shown by
`git rev-parse --path-format=absolute --git-common-dir` from that checkout. It
contains the linked-worktree registrations and Werk ownership markers. A clone
or push alone does not preserve uncommitted worktree changes.

Restore repository data alongside the matching worker-state backup before
resuming intake. Preserve the original paths where possible and verify
`git worktree list` plus the retained task files. Moving repositories may require
repairing Git worktree links and updating assignments while the task queue is
drained. Do not run `git worktree prune` or remove retained directories during
recovery before inspecting them. Protect these backups like the state backup:
they can contain source code, task inputs and provider output.

## Diagnose a crash without deleting durable state

`doctor` reports authenticated service/worker checks and available disk space.
Less than 256 MiB available or less than 5% free fails its storage check. Expand
storage or remove verified expendable artifacts; never clear SQLite WAL files,
identities or pending evidence to recover space. For disconnected workers, use
their status views, verify credentials and connectivity, and restart through the
owning launcher while preserving worker state.

An unreachable supervisor or leftover lock is **uncertain ownership**, not proof
that a process is dead. Retry `status` first. Check the service manager, owning
terminal and process tree; verify all Factory, line and worker writers have
stopped. Stored PIDs can be reused and must never be blindly signalled. If you
cannot prove all writers stopped, do not remove locks or copy live state.

After independently verifying shutdown, preserve a private copy for investigation.
Only then remove the specific stale ownership files: root/line `runtime.lock`
and `supervisor.json`, an interrupted `setup.lock`, or the affected worker's
`worker.lock`. Keep every configuration, credential, database and evidence file.
Rerun `maintenance diagnose`, take a verified backup, and restart through the
original launcher. Werk deliberately provides no automatic stale-PID kill or
lock-deletion command. A maintenance crash may itself leave locks containing
`maintenance: backup`; use the same verified-owner procedure.

## Back up before changing anything

1. Stop the runtime using the launcher and state directory that started it.
2. Verify the services and workers have stopped. Do not copy a live SQLite file.
3. For native or Linux Docker bind storage, copy the **complete** state directory, including configuration, credentials,
   SQLite database/WAL/SHM files, worker identities, snapshots and pending journals.
   Preserve ownership and restrictive access permissions.
4. Back up assigned checkouts and retained task worktrees using the [repository
   procedure above](#preserve-assigned-repositories-and-task-worktrees).
5. Store the backup privately, separately from the release you are replacing.
   Backups contain credentials and source/task evidence; do not commit them.

### Windows Docker named volume

Copy the host pointer/configuration directory **and** back up the stopped owned
volume; `.werk` alone contains no database. Read the volume name from
`.werk/docker-volume.json` and verify its `dev.werk.installation` label matches the
pointer before operating on it. Keep the backup directory private because the
archive includes credentials. With the release operator image available:

```text
docker run --rm --mount type=volume,source=VOLUME_NAME,target=/state,readonly --mount type=bind,source=PRIVATE_ABSOLUTE_BACKUP_DIRECTORY,target=/backup --entrypoint tar werk-release:local -C /state -czf /backup/werk-state.tar.gz .
```

Replace both placeholders with the verified volume and a private existing absolute
host directory. Restore only a trusted backup into an empty, stopped, correctly
owned volume, preserving file ownership/modes and its matching host pointer. Do
not extract into a live volume or use a pointer from an unrelated installation.
The credential export is for login, not a complete backup.

Keep any separately configured Factory/line databases and worker stores together
with their own credentials. A Factory registry backup alone is not a backup of
all lines. The default one-command installation is a complete Factory system;
back up its entire `.werk-system/<system-id>` directory. The separate single-line
tutorial uses `.werk` and contains no Factory.

## Install an upgrade

1. Verify checksums, then extract the new release into a **new** directory.
2. For native/Linux bind storage, keep the complete stopped state outside both
   release directories and select it with `--state-dir /absolute/path/to/state`.
   A deliberately copied default whole-system directory belongs at
   `.werk-system/<system-id>`; `.werk` is only for a single-line runtime. On Windows
   Docker, preserve the host state pointer/configuration and the same owned
   volume. Keep the original backup untouched.
3. Start the new release with that state and the same runtime mode. Check health,
   sign in, inspect existing tasks and confirm the worker identities are intact.
4. Retain the old release and backup until the deployment is accepted.

For a native whole system, run from the new release root with the unchanged
operator-owned YAML and the complete stopped or restored system state:

```text
node werk.mjs system up --file /absolute/path/to/system.yaml --state-dir /private/werk-state --no-open
```

Keep that console running. In a second terminal, verify the same system:

```text
node werk.mjs system doctor --state-dir /private/werk-state --json
```

For a native single line, use `node werk.mjs start --state-dir /private/line-state`
and `node werk.mjs doctor --state-dir /private/line-state --json` instead. Retain
your custom file and state arguments for every future restart. Do not use bare
`node werk.mjs up` to reopen a custom deployment.

Do not run two versions against one state directory. Native and Docker state
modes cannot be switched simply by using another launcher. A runtime migration
requires a compatible, stopped-state procedure; no automatic migration command
is provided. Release manifests inventory files but do not prove database-version
compatibility.

## Restore and roll back

Restore a backup to a new empty state directory using the application version
that created it. Stop all newer writers first. Restore the server and worker
state consistently, including pending evidence and credentials, then verify
health, task history and snapshots before resuming intake.

Do not point an older binary at a database that a newer release has migrated.
Rollback means restoring a compatible backup with its matching release, not
just replacing executable files. Keep the original backup read-only while
rehearsing recovery. A successful local restore does not establish a deployment
recovery-time objective or qualify a live volume copy.
