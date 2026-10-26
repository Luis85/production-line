# Werk

Run one worker from a transparent WerkHome: create a Feature Request, follow live
delivery and review the resulting increment before allowing its exact merge.
The runtime is prebuilt. Native Windows, macOS and Linux need Node.js 24 and Git;
there is no npm installation or project-local worker installation.

## Start your worker

Verify the runtime archive against its exact `SHA256SUMS` entry. Extract its
contents directly into a fresh Home such as `C:\WerkHome`; there is no inner
`werk-{{version}}` folder. Then run:

```sh
node ./worker.mjs
```

PowerShell: `node .\worker.mjs`. You can invoke the launcher from elsewhere:
`node C:\WerkHome\worker.mjs`. Home is anchored to that launcher's directory,
not the shell working directory; `--home PATH` explicitly selects another Home.

The root contains stable launchers and documentation. `runtime/` holds replaceable
prebuilt programs, `projects/` contains visible cloned Git repositories, and
`state/worker` holds fresh private worker state. Never commit the private state.
The launcher starts one worker in the background and opens its local webview.
Startup prints its URL and private credential-file path, never the token itself.
Read the token locally to unlock. `--no-open` avoids launching a browser.

Configure the provider, then register the remote project in **Projects**. Preview
and approve workflow setup, separately approve the committed delivery policy,
and recheck setup. **Workboard → New Feature Request** uses the project's Git
request template and readiness flow. Follow live progress and review changes and
checks before explicitly approving the displayed main-checkout merge.
**Workflow** shows delivery health and honest measurement coverage.

```sh
node ./worker.mjs status
node ./worker.mjs stop
```

Follow [archive to main checkout](docs/tutorials/worker-home-to-main.md) for the
complete journey, and [release verification](docs/reference/releases.md) for exact
artifact checks. GitHub PRs and Releases remain separately approved extensions.
No model call runs merely because the worker starts.

## Existing 0.16 installations

Keep the old runtime and a verified backup. Extract into a fresh Home, inspect
`node worker.mjs migration plan --state-dir ABSOLUTE_OLD_STATE`, stop the old worker
with its matching CLI, then explicitly adopt compatible standalone Home state.
Adoption retains original absolute paths; it does not move/copy state or projects.
Project-installed state is refused and needs old-runtime recovery/export.
See [retained-state adoption](docs/how-to/project-worker.md#existing-standalone-installations).
Do not overwrite an existing Home with an archive or delete retained old paths.

## Advanced component automation

The complete prebuilt CLI lives at `runtime/bin/apps/<kind>/cli.mjs`. Raw worker
commands require an explicit `--state-dir` naming the effective state path;
`state/worker` is only the fresh Home default. The root launcher resolves an
adopted state's selection for lifecycle commands. New worker `init` is retired.
Factory and Orchestrator can still be deployed independently with their complete
app folders. See [prebuilt apps and automation](docs/reference/portable-apps.md).

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
node werk.mjs system plan --file runtime/examples/system.yaml --json
node werk.mjs system up --file runtime/examples/system.yaml
```

Docker (no host Node/npm):

```bash
bash werk-docker.sh system up --file runtime/examples/system.yaml --environment docker
```

On Windows, use `./werk-docker.ps1 system up --file runtime/examples/system.yaml --environment docker`.
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
