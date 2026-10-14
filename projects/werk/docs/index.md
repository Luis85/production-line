# Werk documentation

Werk coordinates software-factory tasks, with simulation by default and opt-in native Linux Codex execution for trusted operators. Start with a tutorial to
run a task; use a how-to guide for a specific operation, reference pages for exact
contracts, and explanations for the design and its limits. This organization
follows [Diátaxis](https://diataxis.fr/).

## Tutorials — learn by running one task

- [Prepare a Linux VM deployment](tutorials/linux-vm-first-task.md): Ubuntu cloud-init, verified artifacts and SSH access.

- [A complete system from YAML](tutorials/system-from-yaml.md): one Factory, logical
  subfactory hierarchy, independent production lines and workers from one definition.

- [Local first task](tutorials/local-first-task.md): extract a release, set it up,
  sign in and inspect one simulated attempt. Requires Node 24, no npm/build.
- [Docker first task](tutorials/docker-first-task.md): the same journey with
  Docker/Compose and Bash or PowerShell, without host Node/npm.

## How-to guides — accomplish a specific goal

- [Assemble independent workers, orchestrators and Factories](how-to/assemble-independent-components.md)
- [Install a project worker and use its feature folder](how-to/project-worker.md)
- [Markdown feature-request contract](reference/feature-requests.md)
- [Use the worker webview](how-to/use-worker-webview.md): Chat, History and Dashboard.

- [Operate, back up and replace a Linux VM](how-to/operate-linux-vm.md)

- [Run an opt-in Codex task and review its patch](how-to/run-codex-task.md)
- [Manage roles, rotate credentials and configure TLS](how-to/manage-access.md)
- [Monitor a runtime and diagnose failures](how-to/monitor-runtime.md)
- [Maintain the installed runtime](how-to/maintain-runtime.md)
- [Upgrade, back up and restore](how-to/upgrade-backup.md)
- [Operate with agents and scripts](how-to/operate-with-agents.md)
- [Develop and test from source](how-to/development.md)
- [Set up a Factory hierarchy](how-to/factory.md)
- [Operate source-checkout fleets](how-to/operations.md)
- [Import a pinned iteration](how-to/pinned-iteration-import.md)
- [Manage worker evidence retention](how-to/worker-retention.md)
- [Use Docker Agent harnesses and MCP](how-to/docker-agent.md)

## Reference — look up a contract

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
