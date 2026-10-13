# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Werk is a downloadable system of independently runnable workers, orchestrators
and Factories. Operators can start one component with one console command, use it
on its own and assemble a larger system later. Each level needs understandable
visual navigation, dedicated dashboards, focused editors and a replayable tour.

## Worker Scope

The user explicitly requested a Vue webview built with Nuxt UI and three pages:
Chat, History, and Dashboard. Chat is the default page and the primary way to
give this worker a new task or continue an existing task’s model session. History
contains the local taskboard and retained orchestrator evidence. Dashboard carries Monitoring & Status: activity, health, environment,
provider connections and optional orchestrator enrollment. The old
`/monitoring-status` route redirects to `/dashboard`; there is no fourth page.

## Existing Implementation Evidence

The repository implements Werk as separate Factory, orchestrator and worker
applications. Simulation is the default. Native Linux Codex execution is opt-in
and produces local patches requiring human review. Current operating details
are maintained in [the documentation hub](docs/index.md).

## Worker Ownership

The worker is installed on a machine and works independently. It can use local
Claude Code / Codex subscription logins or provider APIs. An orchestrator is
optional and can be configured later. Each worker executes exactly one task at a
time across Chat, explicit local file tasks and remote orchestrator assignments.
Its queue can hold more work, but does not add execution slots. Parallel work
requires separate worker instances, each with its own native state directory or
Docker volume and webview port.

Every task owns a dedicated worker-managed LLM session. The first message in
New task queues that task; follow-up messages use the same session. Explicit
file tasks and remote assignments also receive dedicated sessions. Pause holds
all new execution starts while the active task finishes. The worker is the only
component that prompts an LLM; Factory and orchestrator own routing, not model
execution. Chat retains a Run task editor for approved file inputs and patches.

## Assembly, dashboards and routing

A standalone worker owns provider connections, sessions, local task input and
review patches. An independent orchestrator owns its line's task queue, routing,
leases and accepted evidence. Factory owns hierarchy, line registrations and a
durable intake/outbox that forwards accepted work into a line's queue. Component
state and credentials remain separate; Factory is not required for a worker or
orchestrator to run.

Factory opens its aggregate dashboard. Each registered line has a dedicated
dashboard within Factory (`#line=<id>`). An orchestrator opens Dashboard
(`#system`) after authentication; explicit workspace links remain available.
Factory routes automatically by observed project, intake capability, provider,
execution mode and capacity, or manually to a selected line. Orchestrator routing
offers automatic eligible-worker selection or a manual worker target. Routing
changes do not move existing leases or redirect Factory deliveries already begun.

Interaction widgets on line and orchestrator dashboards connect to a registered
worker's selected task session. New task and its first message create work on
that worker; follow-ups continue the same task session. A separate Submit task
action sends work through the owning router, whose worker selection is independent
of the widget's connected worker. The widget forwards requests; only the worker
prompts the model. Browser access tokens stay in memory.

Configured providers, profiles and subscriptions do not establish verified login,
available quota or measured cost. Simulation, local patches requiring review and
accepted/merged work must remain distinct.
