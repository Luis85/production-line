# Run your first task with Docker

You will start one Werk line and worker from the extracted release, submit a task
in the browser, then stop it while preserving its state. You need Docker Engine 26 or newer, Compose 2.35 or newer (or a current Docker Desktop),
and either Bash or PowerShell. **Host Node and npm are not required.**
Docker must be running and able to obtain the release image's base layers.

## Extract and set up

Verify and extract the archive using the [release instructions](../reference/releases.md).
Open a terminal inside `werk-0.1.0`. Use an empty state directory for this tutorial;
a state configured for native execution cannot silently switch to Docker.

Bash:

```bash
bash werk-docker.sh setup
bash werk-docker.sh start
```

PowerShell:

```powershell
./werk-docker.ps1 setup
./werk-docker.ps1 start
```

On Linux/Bash, setup stores configuration and private credentials directly in
`.werk`. Windows/PowerShell uses an owned Docker named volume and keeps a
nonsecret `.werk/docker-volume.json` pointer on the host. This release supports
one Docker worker. Start prepares the runtime image from the packaged applications, starts
the services, waits for health and opens a clean loopback URL. If a browser is
unavailable, open `http://127.0.0.1:3000/` yourself. Add `--no-open` to start when
running headlessly.

## Sign in and observe a task

On Linux, read `WERK_ADMIN_TOKEN` privately from `.werk/credentials.json`. On
Windows, explicitly export a private copy first:

```powershell
./werk-docker.ps1 credentials
```

The command reports the path `.werk/credential-export/credentials.json` without
printing secrets. It creates a new directory with access restricted to the current
user and refuses to overwrite an existing export. Read the token privately there.
Enter the admin token in the login form, then choose **Intake**. Verify the project is `demo` and submit
`[[Features/Customer portal]]`.
The reference does not need to exist for the default unbound mock workflow.

Open the task and wait for **simulated**. Inspect the worker, events and the
before/after snapshot pair. No coding provider, Git push or PR runs in this
exercise. Unknown metrics remain unknown.

## Inspect and stop

Bash:

```bash
bash werk-docker.sh status --json
bash werk-docker.sh logs
bash werk-docker.sh stop
```

PowerShell:

```powershell
./werk-docker.ps1 status --json
./werk-docker.ps1 logs
./werk-docker.ps1 stop
```

Sign out when finished. Stop preserves state; start reuses it. Do not delete the
state directory or Docker volumes to fix a login problem. Use the
[maintenance guide](../how-to/maintain-runtime.md) for diagnosis and the
[backup guide](../how-to/upgrade-backup.md) before an upgrade or migration.

Docker deployment is separate from Docker Agent or live Claude/Codex execution.
See [runtime modes](../explanation/modes.md) for the distinction.
