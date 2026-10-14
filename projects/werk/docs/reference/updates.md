# Automatic updates

Native downloaded releases from 0.2.0 onward check the stable GitHub release before
`node werk.mjs up`, `system up`, `system start` or single-line `start`. The system
updates before starting; running tasks are never interrupted by a background timer.
Keep using the same original `werk.mjs` launcher and the same file/state arguments.
It routes lifecycle commands to the selected release without moving your state.

## Control updates

For the default Factory system:

```sh
node werk.mjs update check
node werk.mjs update status
node werk.mjs update apply
node werk.mjs update disable
node werk.mjs update enable
node werk.mjs up --no-update
```

`check` reads GitHub and reports current/latest versions without changing files.
`status` is local and reports the active version, policy and last backup.
`apply` requires a stopped system, backs up configured state, and selects the new
release without starting it. `disable` and `enable` persist the policy for that
state directory; stop the foreground launcher before changing it.
`--no-update` skips discovery for one startup, while continuing to use the selected
version. `WERK_AUTO_UPDATE=0` does the same for unattended startup.

For a custom system, supply `--file /path/system.yaml` and
`--state-dir /private/system-state` as with startup. With an explicit state path,
check/status/apply can omit the YAML. For a single line, add `--line` and its
`--state-dir`. Explicit path options override the existing `WERK_SYSTEM_FILE` and
`WERK_STATE_DIR` defaults. `--json` returns structured results; startup emits
additional `update_progress`, `updated` or `update_skipped` lifecycle records.

Network failure, rate limiting, invalid checksums, incompatible releases and failed
preflight checks retain the installed selection. Automatic startup reports the
problem and attempts the installed version. Explicit `update apply` exits nonzero.
A damaged selected payload fails closed; use the retained release and backup for
recovery. The updater requires the same Node 24 and tar prerequisites as installation.
In a proxy-only environment, configure Node 24's `NODE_USE_ENV_PROXY=1` and retain
your approved proxy/CA settings.

## State and release safety

Discovery reads `SHA256SUMS` from
`https://github.com/Luis85/production-line/releases/latest/download/SHA256SUMS`.
It requires one complete stable semantic version, never chooses a downgrade, and
pins the subsequent archive request to that exact version. No GitHub token is used.
The archive SHA-256 and extracted file inventory are checked before use. As with
installation, trust comes from this repository and HTTPS; unsigned checksums are
not an independent publisher signature.

A new release must declare `updateProtocol: 1` and `stateFormat: 1` in its manifest.
Maintainers must change the state format when persisted data becomes incompatible;
such changes require a documented manual migration. A matching format is a
compatibility contract, not permission to run two versions against one database.

For state `/private/system-state`, update metadata, immutable releases and backups
live in `/private/system-state.updates/`. This sibling directory is private and
must remain with the state and original launcher. Existing state paths, YAML,
credentials, worker identities, histories and evidence are preserved. The updater
holds a per-state operation lock while starting/running/updating; backup also uses
the runtime's stopped-state locks. A stale lock is never removed automatically.
Confirm its owner and all child processes have exited before manual recovery.

Each activation of an existing state takes a complete checksum-verified native
backup and runs the candidate's stopped-state doctor before switching the selection
atomically. Releases and backups are retained; monitor disk space. A failed first
start can still require recovery: the updater does not silently rewind application
data or retry older code against potentially changed databases.

## Recover a previous version

Stop the running system and disable any external restart automation. Restore the
snapshot into a **new** directory:

```sh
node werk.mjs update rollback --state-dir /private/system-state --to /private/restored-state --json
```

The result identifies the matching `releaseRoot`, restored `stateDir` and version.
Start that release with your original YAML and the restored path:

```sh
node /returned/releaseRoot/werk.mjs up --file /path/system.yaml --state-dir /private/restored-state --no-update
```

For a single line, add `--line` to rollback and use `start` instead of `up`.
Recovery disables automatic updates on the restored instance. The original state,
including tasks created after the upgrade, remains untouched. Verify doctor,
credentials, task histories and worker identities before resuming intake. See the
[backup guide](../how-to/upgrade-backup.md) for manual recovery and stale-lock handling.

## Adopt updates from 0.1.0

Version 0.1.0 predates the updater. After an update-capable release is published,
stop 0.1.0, back up its complete state, then download the new installer with
`--no-start`. Start the new release once with the old absolute state path and
unchanged YAML:

```sh
node /new/werk-0.2.0/werk.mjs up --file /old/werk-0.1.0/examples/system.yaml --state-dir /old/werk-0.1.0/.werk-system/demo-system --no-update
```

Keep those arguments for subsequent starts and retain the old installation that
contains the state/YAML. Future starts through the new launcher perform automatic
checks. Downloading a new installer without selecting the existing state creates a
separate system; it does not discover previous installations.

## Deployment scope

Automatic activation and backup apply to native whole-system and single-line
installations. Docker wrappers and managed VM deployment tooling retain their
pinned-release, stopped-state upgrade procedures. Generated VM services set
`WERK_UPDATES=external`, which bypasses the update manager and its writable sibling
directory entirely. Preserve that variable when manually replacing a managed VM release; no host Node dependency is added
to Docker. Source checkouts use Git and never check GitHub on startup. Refer to
[release artifacts](releases.md), [VM operation](../how-to/operate-linux-vm.md) and
[manual upgrades](../how-to/upgrade-backup.md) for these paths.
