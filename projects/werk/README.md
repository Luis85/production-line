# Werk

**Turn a shared Feature Request into an implementation your team can review.**

Werk runs a worker on your machine, connects it to your project's Git repository
and dispatches approved work to a configured model. Your team collaborates through
Obsidian-compatible Markdown notes; the worker webview offers chat-based request
creation, progress, metrics and configuration. A person reviews the result before
merging.

[Documentation](https://luis85.github.io/production-line/) ·
[Download](https://github.com/Luis85/production-line/releases/latest) ·
[Changelog](CHANGELOG.md) · [Source documentation](docs/index.md)

![Worker taskboard showing capacity and requests grouped by their current state.](docs/evidence/readme/worker-taskboard.png)

*The real worker taskboard with sample local requests. Select a request to inspect its
conversation and progress; use Metrics, History and Settings to inspect and
configure the worker. [Screenshot details](docs/evidence/readme/README.md).*

## Choose your starting point

| You want to… | Start here |
| --- | --- |
| Install a worker in your project | [Project-worker quick start](#install-a-project-worker) |
| Let a team submit requests through Git and Obsidian | [Shared Markdown queue](docs/how-to/shared-feature-intake.md) |
| Create and follow requests in the browser | [Worker webview](docs/how-to/use-worker-webview.md) |
| Run a Factory with multiple production lines | [System deployment](#run-a-factory-and-production-lines) |
| Build or extend the frontend | [Storybook and frontend reference](#documentation-and-frontend-reference) |

This README describes the current source branch. Downloaded applications and the
hosted documentation reflect their published release; use that release's guides
when working with an older installation.

## Install a project worker

Native workers require **Node.js 24.x**. The download command also needs `curl`
and `tar` on PATH. From a directory for downloaded releases:

Linux/macOS (Bash):

```sh
curl -fsSL https://github.com/Luis85/production-line/releases/latest/download/install.mjs -o werk-install.mjs &&
  node werk-install.mjs --no-start
```

Windows (PowerShell):

```powershell
curl.exe -fsSL https://github.com/Luis85/production-line/releases/latest/download/install.mjs -o werk-install.mjs
if ($LASTEXITCODE -eq 0) { node werk-install.mjs --no-start }
```

The installer verifies a version-pinned archive and its extracted files, then
creates `werk-<version>/`. Existing version directories are preserved. The
prebuilt runtime needs no npm installation, compiler or administrator privileges.
You can also download and verify a runtime archive from
[GitHub Releases](https://github.com/Luis85/production-line/releases); choose the
runtime asset, rather than GitHub's source-code archive.

Next, **open a terminal in your team's project directory**. Replace the release
path below with the directory created by the installer. Initialization defaults
to `codex-cli` (Linux/macOS). For Claude Code, including native Windows, use
`init --provider claude-cli` instead. This selection also sets the provider in the
new request template; changing the connection later does not rewrite that template.

```sh
node /path/to/werk-release/bin/apps/worker/cli.mjs init
node bin/apps/worker/cli.mjs run
```

Initialization installs `bin/apps/worker`, a private `.env`, a shareable
`.env.example`, configuration, a Feature Request template, readiness/completion
rules, an Obsidian Base and the offline **Create Feature Request** authoring kit.
Choose a request folder with `init --features-dir requests/features`; the default
is `features`. Keep `.env`, provider credentials and private state out of Git.

The worker prints its local URL. To use the webview, unlock it with
`WERK_WORKER_TOKEN` from your project's `.env`. The token is never put in a browser
URL. `run` stays in the terminal; Ctrl+C stops it. Use `start`, `status` and `stop`
for background operation.

Before submitting shared work:

1. Sign in to Claude Code or Codex CLI on the worker machine, or configure an API
   provider. Check the connection in **Settings → Providers & accounts**.
2. Review the detected project repository and explicitly accept it. Configure
   the repository, remote and shared intake branch.
3. Review the model's file, command and MCP permissions and the required project
   checks. A provider login does not grant tool access.
4. Commit and push the shared template, authoring kit and ready/done rules, then
   connect shared intake using the [setup guide](docs/how-to/shared-feature-intake.md#connect-the-worker).

All setup controls are also available through the CLI. The
[project-worker guide](docs/how-to/project-worker.md) covers browser-free setup,
Docker without host Node, existing repositories, upgrades and environment files.
Portable apps include an npm-compatible `package.json`; run
`npm --prefix bin/apps/worker run` to list the available scripts. No npm install
is needed.

## One Feature Request throughout the workflow

The **Feature Request is the central workflow entity**. Markdown, chat and CLI
intake all target it. Conversations, execution attempts, progress, questions and
review evidence keep the same request identity.

1. **Describe the outcome.** Start from the project's template, in your editor,
   with the Create Feature Request skill, or in the worker's chat interface.
2. **Make it ready.** Complete the goal, context, acceptance criteria,
   verification plan and approved paths. Validate against `fr-ready-check.json`.
3. **Publish to the shared queue.** Mark it ready, commit and push to the watched
   branch. A local save or local commit alone does not start shared work.
4. **Let the worker implement it.** The worker validates and claims the request,
   then uses its configured model and approved tools in an isolated Git worktree.
   It publishes lifecycle updates to the original request.
5. **Answer when needed.** Pull updates and follow the linked Task note. Write
   under `## Answer`, set `status: ready`, then commit and push. The worker resumes
   the same request. You can also answer through its webview conversation.
6. **Review the result.** After the configured `fr-done-check.json` checks, the worker publishes
   a feature branch and a PullRequest Markdown note with evidence. A human
   reviews the changes and decides whether to merge.

| Artifact | What the team uses it for |
| --- | --- |
| Feature Request | The accepted scope, owner, lifecycle and progress |
| Task note | A question, supported continuation, or operator action needed to proceed |
| PullRequest note | The review handoff: implementation branch, results and verification evidence |

A **PullRequest note is a Markdown file**, not an automatically opened GitHub or
GitLab pull request. A blocked Task may require a configuration change; answering
it does not grant new permissions. The developer checkout stays untouched by
shared implementation and publication. See the
[shared workflow guide](docs/how-to/shared-feature-intake.md) for ownership,
retries, conflicts and human review.

## Create requests through Markdown or chat

### From any team member's clone

The committed authoring kit works without a worker connection or provider
credentials. Use the **Create Feature Request** skill in your own environment,
or create a draft from the terminal:

```sh
node .werk/authoring/feature-request.mjs create --name search.md --title "Find matching requests"
```

Fill in the template, including approved paths, then validate it. With the default
request folder:

```sh
node .werk/authoring/feature-request.mjs validate --file features/search.md
node .werk/authoring/feature-request.mjs ready --file features/search.md --if-match REVISION
```

Replace `REVISION` with the successful validation's revision. Commit and push the
ready note to the watched branch. Pull the worker's updates to see progress,
questions and review notes in Markdown or the Obsidian Base. Folder names,
templates and rules are configurable; see [team authoring](docs/how-to/team-feature-authoring.md).

### From the worker webview

Open **Taskboard → New request**, describe the outcome and choose **Prepare
request**. This prepares the committed template without invoking a model. Fill
in the request details and use **Check readiness**, then **Save draft to Git** or
**Mark ready and publish**. Shared intake picks up that same note.

![Shared Feature Request authoring in the worker, with request instructions and the Prepare request action.](docs/evidence/readme/worker-create-request.png)

*The shared-request entry screen with example instructions. The next step lets
you review the template, approved scope and readiness before publishing.*

Once the worker owns the request, open its conversation to follow execution and
answer pending questions. Webview answers publish the same Task response that a
teammate can edit in Markdown. Accepted scope changes require a successor Feature
Request. See the [webview guide](docs/how-to/use-worker-webview.md).

## Inspect and configure the worker

The **Taskboard** shows current work, queue and capacity. **Metrics** explains
measured consumption and execution activity; **History** keeps previous runs and
their evidence. **Settings** holds the worker's operating configuration.

![Worker settings with provider connections and navigation to repositories, tool access and consumption settings.](docs/evidence/readme/worker-settings.png)

*Settings in the real worker UI, using sample configuration. Keep credentials
local to the worker machine.*

| Configure | Where to learn more |
| --- | --- |
| Model providers and available CLI account details | [Provider connections](docs/how-to/use-worker-webview.md#connect-claude-or-codex) |
| Request, Task and review folders; template and rules | [Team workflow configuration](docs/how-to/team-feature-authoring.md) |
| Assigned repositories, watching and worktrees | [Repository setup](docs/how-to/project-worker.md#assign-git-repositories) |
| Built-in file/web tools, approved commands and MCP connections | [Model tool access](docs/how-to/manage-model-tools.md) |
| Daily/monthly allowance and the worker's share | [Consumption limits](docs/how-to/worker-consumption-limits.md) |
| Queue, capacity and execution duration | [Queue configuration](docs/how-to/use-worker-webview.md#configure-the-taskboard-and-orchestrator-queue) |
| Execution profiles and agent definitions | [Profile editing](docs/how-to/use-worker-webview.md#edit-execution-profiles) |
| Launch defaults and the local access token | [Project environment files](docs/reference/configuration.md#project-environment-files) |

Consumption limits allocate a share of a **configured allowance**; they do not
measure your everyday usage elsewhere in the provider account. Provider usage
availability varies. For implementation work, review
[required checks and evidence](docs/how-to/implement-feature.md) before relying
on a model's completion message.

## Run a Factory and production lines

Werk also provides independent Factory and orchestrator applications for teams
operating multiple lines. The [system definition](examples/system.yaml) declares
a Factory, a logical subfactory and two isolated production lines.

From the extracted runtime, start the supplied system with Node 24:

```sh
node werk.mjs system plan --file examples/system.yaml --json
node werk.mjs system up --file examples/system.yaml
```

Or use Docker Engine 26+ and Compose 2.35+ without host Node/npm:

```sh
bash werk-docker.sh system up --file examples/system.yaml --environment docker
```

On Windows, use `./werk-docker.ps1 system up --file examples/system.yaml --environment docker`.
The system opens the Factory once healthy. Follow the
[system tutorial](docs/tutorials/system-from-yaml.md) for credentials, your first
assignment and shutdown. For one line, use the
[native](docs/tutorials/local-first-task.md) or [Docker](docs/tutorials/docker-first-task.md)
first-task tutorial. Running the installer without `--no-start` starts the default
Factory demonstration directly.

**Default Factory/orchestrator assignments are simulated.** Trusted operators can
opt into [native Linux Codex execution](docs/how-to/run-codex-task.md). Supplied
orchestrator Docker and managed VM profiles remain simulated. Standalone workers
use their configured Claude/Codex CLI or API provider; Docker workers need an API
provider or a prepared image with its own CLI authentication. See
[execution modes](docs/explanation/modes.md) for platform limits.

Each application has its own webview, CLI and private state. Use one runtime per
state directory. Operational guides cover [monitoring](docs/how-to/monitor-runtime.md),
[access and TLS](docs/how-to/manage-access.md), [maintenance](docs/how-to/maintain-runtime.md),
[updates](docs/reference/updates.md), and [backup/recovery](docs/how-to/upgrade-backup.md).

## Documentation and frontend reference

The [public Storybook](https://luis85.github.io/production-line/) is the system's
documentation entry point: **Start here → Set up your workspace → Work with
requests → Operate the system → Frontend reference → Architecture and contracts**.

- [Handbook](https://luis85.github.io/production-line/handbook/): searchable setup,
  operating guides and reference documentation.
- [Illustrated UI reference](https://luis85.github.io/production-line/storymap/):
  real Vue components, workflows and desktop/mobile screenshots with sample data.
- [Source documentation hub](docs/index.md): tutorials, how-to guides, reference
  contracts and architectural explanation for this branch.
- [Frontend architecture](docs/reference/webview-architecture.md) and
  [system architecture](docs/explanation/architecture.md): component reuse,
  shared interfaces and application boundaries.

Each release also includes a versioned Storybook ZIP. See
[generate and host Storybook](docs/how-to/generate-storybook.md) for local preview,
qualification and publishing. Historical evidence is kept in
[review reports](docs/reports/index.md); the [concept index](docs/CONCEPT.md)
identifies the original requirements.

## Develop from source

From `projects/werk`, with Node 24 and npm:

```sh
npm ci
npm run check
npm run dev:factory
```

`dev:factory` starts a simulated development fleet. Use `npm run dev:fleet` for
one line or `npm run storybook` for component/documentation development.

| Application | Responsibility |
| --- | --- |
| Factory | Hierarchy, line registry and portfolio summaries |
| Orchestrator | Line intake, routing, leases, context and evidence |
| Worker | Provider execution, shared Markdown lifecycle, worktrees and review evidence |
| Shared | Contracts and reusable primitives across applications |

`npm run check` runs LOC checks, Oxlint, Fallow, architecture rules, source and
test typechecking, builds and tests. Source files are limited to 400 code-bearing
lines and test/support files to 450, excluding blank and comment-only lines.
Source checks also require Python 3 on every platform, including Windows, to
count Python code and run supported infrastructure tests. Downloaded runtimes
do not require it.

Stryker mutation testing runs as an **advisory release check**: findings warn
without blocking development or release. `npm run mutation` runs it explicitly.
`npm run release:build` validates the changelog, builds applications, qualifies
Storybook and packages the runtime and documentation. See
[development](docs/how-to/development.md), [tests](tests/README.md), and
[release procedure](docs/reference/releases.md) for the maintained checks.
