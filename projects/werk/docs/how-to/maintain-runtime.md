# Maintain the installed runtime

Use this guide after completing the local or Docker tutorial. Commands run from
the extracted release root. Keep the same `--state-dir` on every invocation when
you use a custom directory; the default is `.werk` beside the release launcher.

For readiness, request correlation, capabilities and log collection, use
[monitor the runtime](monitor-runtime.md).

## Inspect a native runtime

```text
node werk.mjs status --json
node werk.mjs doctor --json
```

Status reports lifecycle information. Doctor checks readiness and fails when
required checks fail. A stopped runtime may pass doctor as ready to start; inspect
its `state` before treating it as running. Treat exit status and JSON result as
part of the result; an HTTP process answering is not proof of provider execution.

`node werk.mjs open` opens the clean application URL without signing in for you.
`start --no-open` starts without browser launch; `start --json` is the foreground
machine interface and emits lifecycle records. See the
[CLI contract](../reference/runtime-cli.md).

## Inspect a Docker runtime

Use `bash werk-docker.sh status --json` and `bash werk-docker.sh logs`; PowerShell
uses the same actions on `./werk-docker.ps1`. The wrapper owns its Compose project
and state mapping. Use the same wrapper and state directory to stop and restart
it. On Windows, the host directory points to an owned named volume; use the
PowerShell `credentials` action for an explicit private login export. Copying the
host pointer alone is not a database backup. Native and Docker launchers reject a configuration for the other runtime.

## Recover without discarding identity

| Symptom | Next action |
| --- | --- |
| Port already used | Stop the conflicting service or configure an unused port on a fresh setup; do not kill an unidentified process |
| Login rejected | Check the selected state directory and its admin token; do not substitute the enrollment token |
| Task stays queued | Check worker health and its project/profile capacity, then inspect task events |
| Runtime mode mismatch | Use the launcher matching `config.json`; perform a planned migration instead of editing mode while processes run |
| State reports an active owner | Verify whether its runtime is still running; do not delete live ownership metadata |
| Pending evidence after interruption | Preserve worker identity, journals and credentials, then restart with the same state and configuration |
| Task becomes blocked | Inspect its attempt history; there is no automatic unblock/revision command |

A lost worker lease can return a task to queue or block it at the pinned attempt
ceiling. Do not infer completion from a process exit or status page alone.

## Application credentials need repair

For the native single-line runtime, status/stop/open use independent supervisor
authentication while still validating private state, configuration and runtime
mode. They remain available if the application credentials file is missing or
malformed. Doctor reports that credential problem; startup still requires valid
credentials. Stop safely before restoring the original credential file from a
trusted backup. Do not generate replacement tokens for existing identities.

## Stop cleanly

Use `node werk.mjs stop` for native execution, or the Docker wrapper's `stop`.
Native stop uses the private authenticated supervisor control channel; it does
not signal a process solely because an old PID file names it. Wait for shutdown
before copying or replacing state. Preserve logs when reporting a failure, but
review them for sensitive task or repository content before sharing.

Changing connection ports, project or worker configuration can invalidate the
binding of existing worker identities. Stop first and plan compatible new state;
do not delete an identity to bypass an active lease.

For an upgrade, restore or move to a different machine, follow
[upgrade and backup](upgrade-backup.md). Current authentication and deployment
limits are in the [security contract](../reference/security.md).
