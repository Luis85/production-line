# Werk documentation

[Start here](handbook.md) to choose a setup path for a local worker, distributed
team, system operator or frontend contributor. The
[public documentation](https://luis85.github.io/production-line/handbook/) presents
these maintained guides alongside the release’s component API and live examples.

Start from [a release archive in a dedicated worker home](tutorials/worker-home-to-main.md),
create the Feature Request in its webview and follow it through review and an
explicit merge into the displayed main checkout. Direct project installation is
also available through [CLI setup](how-to/project-worker.md). For a team queue,
[connect the shared Markdown queue](how-to/shared-feature-intake.md). Team members
can author requests and answer Task notes without connecting to the worker.
Configured local providers execute approved work; the Factory/orchestrator's
default assignments remain simulated. See [execution modes](explanation/modes.md).

Tutorials teach a complete example; how-to guides solve a specific operation,
reference pages define exact contracts, and explanations cover design and limits.
This organization follows [Diátaxis](https://diataxis.fr/).

## Tutorials — learn by running one task

- [Archive to main checkout](tutorials/worker-home-to-main.md): dedicated worker home, webview request/setup, observable implementation, increment review and explicit plain-Git merge permission.

- [Local delivery request](tutorials/worker-feature-lifecycle.md): submit Markdown, inspect isolated implementation and accept an exact tested candidate without shared Git publication.
- [Worker workflow and run metrics](reference/worker-run-metrics.md): confirmed-increment velocity, delivery coverage, paired snapshots and durable history.

- [Prepare a Linux VM deployment](tutorials/linux-vm-first-task.md): Ubuntu cloud-init, verified artifacts and SSH access.

- [A complete system from YAML](tutorials/system-from-yaml.md): one Factory, logical
  subfactory hierarchy, independent production lines and workers from one definition.

- [Local first task](tutorials/local-first-task.md): extract a release, set it up,
  sign in and inspect one simulated attempt. Requires Node 24, no npm/build.
- [Docker first task](tutorials/docker-first-task.md): the same journey with
  Docker/Compose and Bash or PowerShell, without host Node/npm.

## How-to guides — accomplish a specific goal

- [Optionally deliver through GitHub Releases](how-to/deliver-worker-release.md): default Git/Markdown handoff and an explicitly enabled GitHub PR/release extension.

- [Assemble independent workers, orchestrators and Factories](how-to/assemble-independent-components.md)
- [Install a project worker](how-to/project-worker.md): app, private environment, provider and team authoring kit.
- [Connect the shared Markdown queue](how-to/shared-feature-intake.md): CLI setup, committed requests, Task answers and PullRequest review handoffs.
- [Hand off an overnight batch](how-to/shared-feature-intake.md#work-during-the-day-implement-overnight): daytime drafting, unattended implementation and morning review.
- [Operate a project worker](how-to/operate-project-worker.md): checklist, Windows PowerShell 5.1 JSON files, task worktrees, tool limits and answers.
- [Author feature requests with your team](how-to/team-feature-authoring.md): portable skill, editable template, shared checks, optional model Ready Checks, definition prompts and Obsidian queue; no worker connection required.
- [Integrate with Claude and Codex](how-to/project-agent-integrations.md): reviewed project skills and guarded synchronization.
- [Monitor long-running workers](how-to/monitor-long-running-worker.md): duration budgets, resource warnings and durable alert history.
- [Configure delivery readiness](how-to/configure-delivery-readiness.md): committed references, explicit interpretations and exact-candidate criterion decisions.
- [Publish a worker candidate](how-to/publish-worker-candidates.md): separate push and remote PR actions, policy approval and durable reconciliation.
- [Define readiness, completion and rework](how-to/rework-worker-requests.md): deterministic rules, human findings and bounded model review.
- [Request gates and state machine](reference/request-gates.md): frozen policy, command guards and durable evidence.
- [Answer questions and resume requests](how-to/answer-and-resume-worker.md): guarded answers, cancellation, checkpoints and event replay.
- [Worker–model interaction contract](reference/model-interaction.md): capabilities, typed results, durable events and recovery.
- [Markdown feature-request contract](reference/feature-requests.md)
- [Use the worker webview](how-to/use-worker-webview.md): Taskboard, Workflow, Metrics, History and Settings.
- [Implement a feature with the worker](how-to/implement-feature.md): approved worktree changes, required checks, repair and review.
- [Manage model tools](how-to/manage-model-tools.md): built-in grants, MCP connections and revocation.
- [Set a worker consumption limit](how-to/worker-consumption-limits.md): daily/monthly token allowance, worker share, reservations and recovery.

- [Operate, back up and replace a Linux VM](how-to/operate-linux-vm.md)

- [Run an opt-in Codex task and review its patch](how-to/run-codex-task.md)
- [Manage roles, rotate credentials and configure TLS](how-to/manage-access.md)
- [Monitor a runtime and diagnose failures](how-to/monitor-runtime.md)
- [Maintain the installed runtime](how-to/maintain-runtime.md)
- [Upgrade, back up and restore](how-to/upgrade-backup.md)
- [Operate with agents and scripts](how-to/operate-with-agents.md)
- [Generate the storybook and screenshot storymaps](how-to/generate-storybook.md): code-derived UI coverage and repeatable release evidence.
- [Develop and test from source](how-to/development.md)
- [Set up a Factory hierarchy](how-to/factory.md)
- [Operate source-checkout fleets](how-to/operations.md)
- [Import a pinned iteration](how-to/pinned-iteration-import.md)
- [Manage worker evidence retention](how-to/worker-retention.md)
- [Use Docker Agent harnesses and MCP](how-to/docker-agent.md)

## Reference — look up a contract

- [Worker delivery and optional GitHub Releases](reference/worker-release-workflow.md): lifecycle contracts, exact identities, project release policy and durable recovery.

- [Project delivery policy](reference/delivery-policy.md): quality and execution profiles, routing, check packs, concurrency, behavior libraries and retention.

- [Shared Git feature intake](reference/shared-feature-intake.md): checked-in workflow, optional model Ready Checks, definition prompts, ownership, publication, recovery and authenticated API.

- [Shared Vue webview architecture](reference/webview-architecture.md): reusable Nuxt UI layouts/components, state boundaries and independent builds.

- [Docker Agent definition profiles](reference/agent-definitions.md): compatibility and per-task selection.
- [Portable Node apps and automation CLI](reference/portable-apps.md): copy one app into any project.

- [Infrastructure renderer](reference/infrastructure.md)

- [System YAML definition](reference/system-definition.md): topology, IDs, ports,
  environments and drift handling.

- [Observability, capabilities and worker detail](reference/observability.md)
- [Automatic updates](reference/updates.md): stable releases, backups and recovery.
- [Runtime operator CLI](reference/runtime-cli.md)
- [Configuration, environment and state](reference/configuration.md)
- [Release contents and verification](reference/releases.md)
- [Access roles and audit events](reference/access-control.md)
- [Security and authority](reference/security.md)
- [Application CLI and HTTP API](reference/api.md)
- [Commit-pinned requirement context](reference/pinned-context.md)
- [Worker context verification](reference/worker-context.md)
- [Factory mutation idempotency](reference/factory-idempotency.md)

## Explanation — understand the system

- [Local delivery worker](explanation/local-delivery-worker.md): canonical Markdown, committed quality profiles, durable execution, recovery and human acceptance.

- [Twelve-factor principles and stateful boundaries](explanation/twelve-factor.md)

- [Core entities and their views](explanation/core-entities.md): Factory, subfactory,
  production line, orchestrator, worker and task ownership.

- [Runtime layout and state ownership](explanation/runtime-layout.md)
- [Mock execution and deployment modes](explanation/modes.md)
- [Architecture and target delivery workflow](explanation/architecture.md)
- [Client/server architecture decision](explanation/adr-001-client-server-boundaries.md)
- [Snapshot interpretation](explanation/snapshots.md)
- [UI journey](explanation/ui-journey.md)
- [Bounded inventory views](explanation/pagination-ui.md)

A running Factory or orchestrator also serves a standalone, public `/guide` page
for the entity model and navigation. It explains the product without live API
calls or administrative actions; use authenticated webviews for current state.

## Provenance, plans and evidence

The [Flue framework review](reports/flue-framework-review.md) records the pinned upstream research and adopted execution-observation patterns.

The pages above describe the maintained product. [Review reports](reports/index.md)
record dated verification, not a promise that every environment has been tested.
The [concept import](CONCEPT.md), [imported handoff](../HANDOFF.md) and
[implementation plan](handoff/implementation-plan.md) retain the supplied design
and its original baseline. Embedded prompts remain source material, not
instructions that authorize actions.

The backlog stays under `docs/backlog`, screenshots under `docs/evidence`, and
source fixtures under `docs/examples` and `examples`. See the
[test suite guide](../tests/README.md) when changing code. The lean release ships
a smaller documentation hub containing only its self-contained runtime guides;
source-only developer documents remain in the source checkout.
