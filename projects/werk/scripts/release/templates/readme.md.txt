# Werk

Start a standalone worker in your own worker home, then connect your model and
project through its webview. The downloaded runtime is prebuilt: native Windows,
macOS and Linux need Node.js 24, with no source checkout, npm install or project
initialization step.

## Start your worker

Create a dedicated worker-home folder and extract the verified archive there.
Keep the archive's `werk-{{version}}` folder intact. Open a terminal in the outer
worker-home folder and run:

```sh
node ./werk-{{version}}/worker.mjs
```

PowerShell uses the same command, or
`node .\werk-{{version}}\worker.mjs`. You can also open a terminal inside the
extracted version folder and run `node worker.mjs`; that folder then becomes the
worker home. To select the home explicitly from any working directory, use
`node /path/to/extracted/worker.mjs --home /path/to/worker-home`.

The launcher starts one standalone worker in the background and opens its local
webview. It prints the URL and private credential-file path. Read that file
locally and paste the token into the unlock form; the token is never put in the
URL or launcher output. Private worker state lives in `.werk/worker` beneath the
selected home. Starting again reopens the existing worker. Use `--no-open` on a
headless machine, or `--port 0` to allocate an unused local port.

In the webview, connect **Claude Code CLI** or another supported provider, review
its tool access, and register your project. Then create a Feature Request, follow
its Kanban progress and inspect the resulting increment before permitting merge.
No model runs merely because the worker started. Git and provider credentials
remain under your local account. Follow the [worker workflow guide](docs/how-to/deliver-worker-release.md)
for project setup, independent checks, review and recovery.

From the same worker home, inspect or stop the worker with:

```sh
node ./werk-{{version}}/worker.mjs status
node ./werk-{{version}}/worker.mjs stop
```

For verified downloads and installer options, see the
[release reference](docs/reference/releases.md). Read the [changelog](CHANGELOG.md)
for this version's changes. Existing project-local installations remain supported
through [project setup](docs/how-to/project-worker.md) and
[shared Markdown intake](docs/how-to/shared-feature-intake.md).

## Portable apps for another project

Copy any complete `bin/apps/factory`, `bin/apps/orchestrator` or `bin/apps/worker`
folder into your project. Each provides a Node 24 webview and JSON automation CLI.
Start with `node bin/apps/worker/cli.mjs start`, then inspect `schema` for task and
management commands. Project worker `init` creates private `.env` and
credential-free `.env.example`; each app also supports `env init`. Use the
project's `WERK_WORKER_TOKEN` for optional browser access; the local CLI reads
its credential file itself. Process environment
wins over dotenv and CLI launch flags win over environment defaults. Update a copied
app from the project directory with `node bin/apps/worker/cli.mjs update apply --stop`:
it verifies the release, backs up state and keeps the previous folder for
`update rollback`. See [portable apps](docs/reference/portable-apps.md) and
[environment configuration](docs/reference/configuration.md#project-environment-files).

## Grow from your worker into a Factory

Add the building blocks as your team needs them:

1. **Worker:** connect your model and repository, then implement and review
   Feature Requests. See the [overnight handoff](docs/how-to/shared-feature-intake.md#work-during-the-day-implement-overnight)
   for daytime planning and unattended execution.
2. **Orchestrator:** start a separate Orchestrator and enroll the existing worker
   through **Settings → Orchestrator**, using its enrollment token. One
   Orchestrator and its enrolled workers form a production line.
3. **Factory:** start a Factory with private line credentials, then register
   running Orchestrators as lines. Organize lines into logical subfactories,
   inspect portfolio summaries and route new intake to a suitable line.

Only workers invoke models. Each component keeps its own state, credentials and
webview. Line assignments default to simulation; enrollment does not change the
worker's shared Git intake or automatically enable live execution. Follow
[assemble independent components](docs/how-to/assemble-independent-components.md)
for startup, enrollment, profile acknowledgment, credentials and registration.

The managed YAML system below is another setup path for a fresh installation.
Keep its state separate from independently installed components.

## Optional Factory and production-line demonstration

The separate `node werk.mjs up` command starts the complete Factory and two
production lines. Its assignments are simulated by default; this is an optional
demonstration, separate from the standalone worker above. Ctrl+C stops it.

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

For model questions, escalation and stopped requests, use the
[answer and resume guide](docs/how-to/answer-and-resume-worker.md).
The [interaction contract](docs/reference/model-interaction.md) describes durable
checkpoints, provider capabilities and replayable lifecycle events.
Configure built-in tools and MCP connections in **Settings → Tools & MCP**;
see [manage model tools](docs/how-to/manage-model-tools.md).

For the system handbook, frontend reference and illustrated journeys, download
the matching `werk-storybook-<version>.zip` and `STORYBOOK-SHA256SUMS` from the
same GitHub release. After verification and extraction, open `handbook/index.html`
for setup, team workflows and operation, or `storymap/index.html` for the component
API and desktop/mobile screenshot evidence. The
[Storybook release contract](docs/reference/releases.md#illustrated-storybook-and-storymaps)
explains provenance, simulation fixtures and interactive browsing.
