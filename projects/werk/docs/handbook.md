# Build your workspace with Werk

Give a worker a feature request, follow its progress, and review the result.
Start with a worker on your own machine, share a Git-backed request queue with
teammates, or operate multiple production lines. Choose the path that matches
your role; a local worker does not require a Factory or orchestrator.

## Choose your starting point

| I want to… | Start here | What I need |
| --- | --- | --- |
| Use a worker on my computer | [Start WerkHome](tutorials/worker-home-to-main.md), then register a remote project | A verified runtime release, Node 24 and a provider account for real execution |
| Share feature requests with a team | [Create requests from any environment](how-to/team-feature-authoring.md), then [connect the shared queue](how-to/shared-feature-intake.md) | A shared Git repository, the project template and readiness/done rules; one member runs the worker |
| Operate a Factory and production lines | [Set up a complete system](tutorials/system-from-yaml.md) | Node 24, or Docker Engine 26+ and Compose 2.35+; separate runtime state and credentials |
| Build or integrate the frontend | [Frontend architecture and state](reference/webview-architecture.md), then [develop components and stories](how-to/generate-storybook.md) | Source checkout, Node 24 and `npm ci`; component API and live examples are linked from the header |

## Your first useful result

1. **Start and connect.** Extract a verified archive directly into a fresh WerkHome and run `node worker.mjs`. Configure the provider, clone/register the remote project and inspect its visible `projects/` checkout. Private worker state remains under `state/`; no worker is installed in the source project.
2. **Prepare the team contract.** Commit the template, Obsidian Base and ready/done rules. Add the optional offline authoring kit/skills explicitly when your team needs them. Review model tool access and required checks with the worker operator. Keep credentials and private worker state out of Git.
3. **Describe and submit the work.** Choose **Workboard → New Feature Request**, create a draft from the project template, list approved files and observable acceptance criteria, then validate it. Mark it ready and commit and push it to the shared intake branch. A local save or local commit alone does not dispatch shared work.
4. **Follow, answer and review.** Pull the branch to read progress in the original request. Follow its Task link, write an authorized answer under **Answer**, set `status: ready`, then commit and push. The worker continues after validation. Inspect the final PullRequest Markdown note, feature branch and check evidence before human merge.

Follow [Implement and review a feature](how-to/implement-feature.md) for the full
coding workflow, including tool grants, checks, repair limits and review evidence.
A successful text answer alone does not establish that a feature was implemented.

## Understand what can run

- **Local workers** accept requests without an orchestrator. Provider, tool and file grants determine what an invocation can do. Task worktrees isolate committed Git input; uncommitted changes are excluded.
- **Shared team intake** reads committed and pushed Obsidian-compatible requests and Task answers, validates readiness and response identity, and publishes progress and PullRequest notes with a feature branch. Teammates need no worker connection. Human merge stays separate.
- **Factory systems** organize independent lines and workers. Their default assignment flow is explicitly simulated. Opt-in native Codex assignment has a separate Linux-only authority boundary.
- **This documentation** is static. Interactive stories use deterministic fixtures and never contact a model provider or start a runtime. Follow the installation instructions in your own environment for real execution.

Read [execution modes](explanation/modes.md) before choosing a deployment or
interpreting a simulated result as software delivery.

## Find the next answer

- **Configure a worker:** [CLI setup](how-to/shared-feature-intake.md#connect-the-worker), optional [workspace settings](how-to/use-worker-webview.md), [tools and MCP](how-to/manage-model-tools.md), [daily/monthly consumption](how-to/worker-consumption-limits.md), [environment files](reference/configuration.md).
- **Keep work moving:** [answer and resume](how-to/answer-and-resume-worker.md), [readiness, completion and rework](how-to/rework-worker-requests.md), [run metrics](reference/worker-run-metrics.md).
- **Operate safely:** [monitoring](how-to/monitor-runtime.md), [access and credentials](how-to/manage-access.md), [backup and upgrades](how-to/upgrade-backup.md).
- **Integrate or contribute:** [CLI and HTTP contracts](reference/api.md), [architecture](explanation/architecture.md), [source development](how-to/development.md), [release qualification](reference/releases.md).

Use **Search documentation** to find a topic or page heading. On smaller screens,
open **Browse documentation** first. Every page is generated from maintained
repository Markdown and identifies its release and source commit. The separate
component catalog derives props, events and routes from the actual Vue source;
its screenshots document observed desktop and mobile states.
