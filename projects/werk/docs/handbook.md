# Build your workspace with Werk

Give a worker a feature request, follow its progress, and review the result.
Start with a worker on your own machine, share a Git-backed request queue with
teammates, or operate multiple production lines. Choose the path that matches
your role; a local worker does not require a Factory or orchestrator.

## Choose your starting point

| I want to… | Start here | What I need |
| --- | --- | --- |
| Use a worker on my computer | [Install a local worker](how-to/project-worker.md), then [run one request](tutorials/worker-feature-lifecycle.md) | A verified runtime release, Node 24 and a provider account for real execution |
| Share feature requests with a team | [Create requests from any environment](how-to/team-feature-authoring.md), then [connect the shared queue](how-to/shared-feature-intake.md) | A shared Git repository, the project template and readiness/done rules; one member runs the worker |
| Operate a Factory and production lines | [Set up a complete system](tutorials/system-from-yaml.md) | Node 24, or Docker Engine 26+ and Compose 2.35+; separate runtime state and credentials |
| Build or integrate the frontend | [Frontend architecture and state](reference/webview-architecture.md), then [develop components and stories](how-to/generate-storybook.md) | Source checkout, Node 24 and `npm ci`; component API and live examples are linked from the header |

## Your first useful result

1. **Install and connect.** Download a runtime from [Werk Releases](https://github.com/Luis85/production-line/releases), verify its checksum, and install the worker in your project. It creates a private `.env` and a shareable `.env.example`. Open the printed local URL and unlock it with the private worker token.
2. **Authorize the workspace.** Review the detected Git repository before accepting it. Connect a supported API provider or your local Claude/Codex CLI account. Keep API keys and tokens out of requests and Git.
3. **Describe the work.** Use Taskboard to create a Markdown feature request. For implementation, choose approved file paths, an execution profile and required checks. The worker prepares an isolated worktree and records progress with the request.
4. **Follow and review.** Taskboard shows preparation, queue, capacity and required decisions. Metrics and History show measured consumption and evidence. Inspect the candidate changes and check results before human review and merge.

Follow [Implement and review a feature](how-to/implement-feature.md) for the full
coding workflow, including tool grants, checks, repair limits and review evidence.
A successful text answer alone does not establish that a feature was implemented.

## Understand what can run

- **Local workers** accept requests without an orchestrator. Provider, tool and file grants determine what an invocation can do. Task worktrees isolate committed Git input; uncommitted changes are excluded.
- **Shared team intake** reads Obsidian-compatible requests from Git, validates configurable readiness rules, and publishes lifecycle/review notes with a feature branch. Teammates can author requests without connecting to the worker. Human merge stays separate.
- **Factory systems** organize independent lines and workers. Their default assignment flow is explicitly simulated. Opt-in native Codex assignment has a separate Linux-only authority boundary.
- **This documentation** is static. Interactive stories use deterministic fixtures and never contact a model provider or start a runtime. Follow the installation instructions in your own environment for real execution.

Read [execution modes](explanation/modes.md) before choosing a deployment or
interpreting a simulated result as software delivery.

## Find the next answer

- **Configure a worker:** [workspace settings](how-to/use-worker-webview.md), [tools and MCP](how-to/manage-model-tools.md), [daily/monthly consumption](how-to/worker-consumption-limits.md), [environment files](reference/configuration.md).
- **Keep work moving:** [answer and resume](how-to/answer-and-resume-worker.md), [readiness, completion and rework](how-to/rework-worker-requests.md), [run metrics](reference/worker-run-metrics.md).
- **Operate safely:** [monitoring](how-to/monitor-runtime.md), [access and credentials](how-to/manage-access.md), [backup and upgrades](how-to/upgrade-backup.md).
- **Integrate or contribute:** [CLI and HTTP contracts](reference/api.md), [architecture](explanation/architecture.md), [source development](how-to/development.md), [release qualification](reference/releases.md).

Use **Search documentation** to find a topic or page heading. On smaller screens,
open **Browse documentation** first. Every page is generated from maintained
repository Markdown and identifies its release and source commit. The separate
component catalog derives props, events and routes from the actual Vue source;
its screenshots document observed desktop and mobile states.
