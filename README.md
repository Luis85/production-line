# Werk · production-line

**A project-local worker that turns Feature Requests into reviewable software changes.**

Install a worker in your project's `bin` folder, connect a model on that machine,
and let your team collaborate through Git-backed, Obsidian-compatible Markdown.
The worker implements ready requests in isolated worktrees, records progress,
asks for input through Task notes and publishes a feature branch with a
PullRequest review note. Your team stays in control of the merge.

[Get started](projects/werk/README.md#install-a-project-worker) ·
[Download](https://github.com/Luis85/production-line/releases/latest) ·
[Documentation & Storybook](https://luis85.github.io/production-line/) ·
[Changelog](projects/werk/CHANGELOG.md)

![Werk worker taskboard showing available capacity, requests needing attention and queued work.](projects/werk/docs/evidence/readme/worker-taskboard.png)

*The real worker UI with sample local requests. Inspect capacity and the queue,
open a request's conversation, or use Metrics, History and Settings.
[Screenshot details](projects/werk/docs/evidence/readme/README.md).*

## One request, two ways to work

The **Feature Request is the central workflow entity**. Team members can create
it in their own editor with the project's **Create Feature Request** skill, or
through the worker's webview chat. Both use the same template, readiness rules,
request identity and shared Git lifecycle.

1. Describe the outcome, acceptance criteria, verification plan and approved files.
2. Validate the request, mark it ready, then **commit and push** to the watched branch.
3. The worker claims it and dispatches implementation to its configured model.
4. Pull progress updates. If a Task needs an answer, write it in the note, mark it
   ready and push; answering in the webview continues the same request.
5. Review the published feature branch and **PullRequest Markdown note**, then
   decide whether to open a Git-hosting pull request and merge.

The team can work entirely through Markdown. The webview also provides request
creation, conversations, queue/capacity, metrics and configuration for providers,
accounts, repositories, execution profiles, built-in tools, MCP and consumption
limits. [See the illustrated worker guide](projects/werk/README.md).

## Choose your setup

| Your role | Start here |
| --- | --- |
| Worker owner | [Install a project worker](projects/werk/README.md#install-a-project-worker), then [connect the model and shared Git queue](projects/werk/docs/how-to/shared-feature-intake.md#connect-the-worker) |
| Team member | [Create Feature Requests from any clone](projects/werk/docs/how-to/team-feature-authoring.md); no worker connection is needed |
| Webview user | [Create requests, follow progress and configure the worker](projects/werk/docs/how-to/use-worker-webview.md) |
| System operator | [Deploy a Factory and production lines from YAML](projects/werk/docs/tutorials/system-from-yaml.md) |
| Frontend contributor | [Public Storybook](https://luis85.github.io/production-line/) and [frontend architecture](projects/werk/docs/reference/webview-architecture.md) |

Prebuilt native apps require **Node.js 24.x** and no npm install or compiler.
Docker operation is also supported. The project-worker setup creates a private
`.env`, a shareable `.env.example`, the request template, ready/done checks and
an Obsidian Base. See the [quick start](projects/werk/README.md#install-a-project-worker)
for verified downloads and platform-specific commands.

**Execution modes:** standalone workers use configured Claude/Codex CLI or API
providers with explicit file/tool permissions. Default Factory/orchestrator
assignments are simulated; opt-in native Linux Codex execution is available.
Supplied orchestrator Docker/VM profiles remain simulated. See
[execution modes](projects/werk/docs/explanation/modes.md).

This README describes the current branch. Downloads and hosted documentation
reflect their published release; use the matching release guides for older
installations.

## Documentation

- [Handbook](https://luis85.github.io/production-line/handbook/): workspace setup,
  team workflows, operation and reference contracts.
- [Illustrated UI reference](https://luis85.github.io/production-line/storymap/):
  real components and complete journeys, with labelled sample data.
- [Source documentation](projects/werk/docs/index.md): current branch guides and
  [architecture](projects/werk/docs/explanation/architecture.md).
- [Releases and updates](projects/werk/docs/reference/releases.md): verified
  archives, changelog process and qualification checks.

## Contribute

Application source lives in `projects/werk`, with Factory, orchestrator, worker
and shared packages. With Node 24 and npm:

```sh
cd projects/werk
npm ci
npm run check
npm run dev:factory
```

The development fleet is simulated. The checks cover architecture, LOC, Oxlint,
Fallow, source/test typechecking, builds and tests. Mutation testing is advisory
in the release pipeline. See [development](projects/werk/docs/how-to/development.md),
[tests](projects/werk/tests/README.md), and
[Storybook development](projects/werk/docs/how-to/generate-storybook.md).

This repository uses the bundled **Forge** CLI for guarded project editing.
Read [AGENTS.md](AGENTS.md) and the installed skills before changing files:

```sh
node bin/forge.js project open werk
node bin/forge.js project current
node bin/forge.js vault check --strict
node bin/forge.js project close
```

The [concept index](projects/werk/docs/CONCEPT.md) and
[review archive](projects/werk/docs/reports/index.md) retain requirements and
historical evidence.
