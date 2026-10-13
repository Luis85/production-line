# Werk

Werk models a Factory with logical subfactories and independent production lines. Each line has its own orchestrator, workers and task history. Run the hierarchy from one YAML definition, or start a single line for a smaller deployment.

**Simulation is the default.** Workers record mock attempts and evidence, ending tasks as `simulated`. Trusted operators can opt into [native Linux Codex execution](docs/how-to/run-codex-task.md), which produces a local patch and a `review` task. Human review, publication and merge remain explicit operator actions. Docker and the managed VM profile remain simulation deployments.

## Download and start

Requires **Node.js 24.x**, `curl` and `tar` on PATH (the download tools are included in current Windows and macOS; install them with your Linux package manager if missing). From the directory where you want to install Werk, download the latest stable release and start it with one command:

Linux/macOS (Bash):

```sh
curl -fsSL https://github.com/Luis85/production-line/releases/latest/download/install.mjs -o werk-install.mjs && node werk-install.mjs
```

Windows (PowerShell):

```powershell
curl.exe -fsSL https://github.com/Luis85/production-line/releases/latest/download/install.mjs -o werk-install.mjs; if ($LASTEXITCODE -eq 0) { node werk-install.mjs }
```

This runs the installer published by this repository. It pins the version and archive SHA-256, verifies the downloaded archive and extracted files, and installs into `werk-<version>/` in your current directory. It needs no npm, compiler, Git checkout or administrator privileges. An existing version directory is never overwritten.

The command starts a local Factory and two **simulated** production lines, opens the Factory page when healthy, and prints the private credential file location. Keep the console open; Ctrl+C shuts the system down. To restart, open the installed version directory and run:

```sh
node werk.mjs up
```

For headless startup, append `--no-open` to either Node command. To download without starting, use `node werk-install.mjs --no-start`. Installer options and publishing instructions are in the [release reference](docs/reference/releases.md).

Alternatively, download a versioned `werk-<version>.zip` or `.tar.gz` asset and its `SHA256SUMS` from [GitHub Releases](https://github.com/Luis85/production-line/releases). Verify the checksum and extract the archive into its own directory. Choose the runtime asset rather than GitHub's automatic source-code download. If no release asset is listed, a release has not been published yet; use the development setup below.

The runtime archive contains prebuilt applications. It does not require npm installation or a compiler. Choose one runtime for each state directory; do not start native and Docker processes against the same database.

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

### Single line: native Node 24

With Node.js 24 installed, open a terminal in the extracted directory:

```text
node werk.mjs setup
node werk.mjs start
```

Setup creates configuration and separate private credentials in `.werk/`. Repeating setup preserves them. Start waits for the orchestrator and worker, then opens the orchestrator in your browser. If automatic opening is unavailable, use the URL printed by start. Keep the terminal running; Ctrl+C shuts down the worker before the server.

The webview explains where to find the admin credential, then guides you through a first task and its simulated result. Follow the complete [native tutorial](docs/tutorials/local-first-task.md) for prerequisites, custom settings and expected results.

### Single line: Docker, no host Node required

Install Docker Engine 26+ with Compose 2.35+ (or a current Docker Desktop). On Linux or macOS:

```sh
./werk-docker.sh setup
./werk-docker.sh start
```

On Windows with Docker Desktop using Linux containers:

```powershell
./werk-docker.ps1 setup
./werk-docker.ps1 start
```

The wrappers configure persistent state, build the runtime image from the prebuilt release, wait for health and open the orchestrator. See the [Docker tutorial](docs/tutorials/docker-first-task.md) for platform-specific state and credential locations, first image download, headless operation and stopping the system.

## Operate and maintain

Native commands include `status`, `doctor`, `stop` and `open`. Use `--json` and `--no-open` for automation; start remains a foreground process. Docker wrappers expose the corresponding container operations. No command silently resets application state or upgrades an installation in place.

- [Manage roles and TLS ingress](docs/how-to/manage-access.md): viewer/operator credentials, rotation and audit events.
- [Run a trusted Codex task](docs/how-to/run-codex-task.md): explicit native policy and local patch review.
- [Monitor a runtime](docs/how-to/monitor-runtime.md): readiness, capability observations, worker detail, request IDs and bounded logs.
- [Maintain a runtime](docs/how-to/maintain-runtime.md): inspect health, start, stop and recover.
- [Operate with agents](docs/how-to/operate-with-agents.md): structured commands and safe credential handling.
- [Upgrade and back up](docs/how-to/upgrade-backup.md): stop writers, retain state and verify a separate installation.
- [CLI reference](docs/reference/runtime-cli.md) and [configuration](docs/reference/configuration.md): exact options, outputs and state layout.

The Factory and each orchestrator also serve a public `/guide` page explaining
entities and navigation without accessing live APIs or performing actions.

## Documentation

The [documentation hub](docs/index.md) follows Diátaxis:

- **Tutorials** teach the native and Docker first-task journeys.
- **How-to guides** explain specific operating and development tasks.
- **Reference** defines commands, configuration, API and security contracts.
- **Explanation** describes architecture, runtime ownership and simulation limits.

Historical reviews live in `docs/reports/`; imported planning and handoff material are identified separately. The [concept index](docs/CONCEPT.md) and [backlog](docs/backlog/Product%20Backlog.base) retain the project's source requirements.

## Develop from source

Contributors need Node 24 and npm. From this project directory:

```text
npm ci
npm run check
node werk.mjs setup
node werk.mjs start
```

The check command typechecks, builds all three applications and runs the recursive test suites. `npm run release:build` creates the distributable archives; see [release reference](docs/reference/releases.md) for verification and publishing gates. The user-facing runtime consumes the same prebuilt distributions tested here.

Existing developer launchers remain available: `npm run dev:fleet` for one line, and `npm run dev:factory` for Factory with two lines. See [development](docs/how-to/development.md), [Factory setup](docs/how-to/factory.md) and the [test guide](tests/README.md).

| Application | Responsibility | Distribution |
| --- | --- | --- |
| Factory | Hierarchy, line registry and read-only portfolio summaries | `src/factory/dist` |
| Orchestrator | Intake, task state, leases, context and evidence API | `src/orchestrator/dist` |
| Worker | Simulated or explicitly enabled native Codex execution, durable journal and local status | `src/worker/dist` |

Shared contracts remain in `src/shared`. Source and tests are grouped by concern. Runtime application data belongs in a private state directory, not the source tree or release archive.

The complete source check also requires Python 3 on Linux/macOS for the infrastructure safety suite. The downloaded native runtime has no host Python dependency.

The [worker webview](docs/how-to/use-worker-webview.md) provides Vue + Nuxt UI pages for Chat, History, and Monitoring & Status. Optional native Linux Codex chat uses the worker account’s existing login.
