# Werk

Run a local software-factory line, submit requirement references and inspect worker
attempts and evidence. **Simulation is the default**: a simulated task does not
produce code. Trusted operators can [enable native Linux Codex execution](docs/how-to/run-codex-task.md)
to produce a local patch requiring human review. Git publication and merge remain
operator actions. Orchestrator execution in the supplied Docker and managed VM profiles remains simulated. Standalone worker Chat and approved-file tasks can use configured API providers, including in Docker. See [project worker setup](docs/how-to/project-worker.md) for terminal and Docker installation.

Verify and extract the release, then open a terminal in this directory. With Node.js 24 installed, start the complete Factory system in one command:

```sh
node werk.mjs up
```

This creates or preserves private configuration, starts the Factory and both simulated production lines, and opens the Factory page when healthy. The console prints the credential file location. Ctrl+C shuts down the system; run the same command to restart. Use `--no-open` on a headless machine. No npm install or build is needed.

Subsequent native starts check stable GitHub releases, verify updates and back up existing state before activation. Run `node werk.mjs update check` to inspect releases or `node werk.mjs update disable` to opt out. `--no-update` skips one startup check. See [automatic updates](docs/reference/updates.md) for recovery and adopting state from 0.1.0.

For automatic download and startup from GitHub, installer options and release verification, see the [release reference](docs/reference/releases.md).

## Portable apps for another project

Copy any complete `bin/apps/factory`, `bin/apps/orchestrator` or `bin/apps/worker`
folder into your project. Each provides a Node 24 webview and JSON automation CLI.
Start with `node bin/apps/worker/cli.mjs start`, then inspect `schema` for task and
management commands. See [portable apps](docs/reference/portable-apps.md).

## A complete system from one YAML file

The supplied [system definition](examples/system.yaml) declares a Factory, one
logical subfactory and two isolated production lines with their orchestrators and
workers. Tasks are submitted inside a line after startup. See
[core entities](docs/explanation/core-entities.md) for ownership and views.

Native (Node 24):

```text
node werk.mjs system plan --file examples/system.yaml --json
node werk.mjs system up --file examples/system.yaml
```

Docker (no host Node/npm):

```bash
bash werk-docker.sh system up --file examples/system.yaml --environment docker
```

On Windows, use `./werk-docker.ps1 system up --file examples/system.yaml --environment docker`.
Choose one environment for a state directory. The system opens the Factory landing
page after all services are healthy. Follow the
[system tutorial](docs/tutorials/system-from-yaml.md) for prerequisites, separate
Factory/line credentials, your first task and shutdown. The single-line commands
below remain useful for a smaller deployment.

## Single line: native Node 24

```text
node werk.mjs setup
node werk.mjs start
```

No npm install or build step is needed. Start opens the browser when the services
are ready. Enter `WERK_ADMIN_TOKEN` from the private `.werk/credentials.json` file
in the login form. Follow the [local first-task tutorial](docs/tutorials/local-first-task.md).

## Single line: Docker, no host Node or npm

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

Use a new state directory when choosing a different runtime. The single-line Docker helper supports one
worker; the YAML system operator supports multiple configured lines/workers. Follow the [Docker tutorial](docs/tutorials/docker-first-task.md)
for credentials, Windows volume storage, inspection and shutdown.

For health, request correlation and bounded logs, use the
[monitoring guide](docs/how-to/monitor-runtime.md). Factory and orchestrator also
serve a standalone public `/guide` explaining the product without live API calls
or administrative actions.

For automation, use the [agent guide](docs/how-to/operate-with-agents.md). For
upgrades and recovery, preserve state and follow the
[backup guide](docs/how-to/upgrade-backup.md). The
[documentation hub](docs/index.md) routes all runtime guides and references.
