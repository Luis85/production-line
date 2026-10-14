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
provider connections and optional orchestrator enrollment. Chat also provides
provider setup and checks, saved task selection, and Docker Agent definition
import without leaving the conversation. The old
`/monitoring-status` route redirects to `/dashboard`; there is no fourth page.

## Worker Access

The worker opens a dedicated unlock screen before showing its workspace. An
operator enters the private worker access token from the worker's state
directory. Successful unlock replaces that entry with a separate HttpOnly browser
session lasting up to 12 hours; reloads preserve access, while Lock, expiry or a
worker restart requires another unlock. Expired access retains unsent drafts in
the current tab; explicit Lock clears them. Running tasks continue on the worker.
The durable token is not saved in a URL, browser storage or the session cookie.
Workspace access and model-provider authentication are separate steps.

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

## Worker Provider and Agent Definitions

Provider connections belong to the worker. Chat exposes the same saved connection
settings as Dashboard, with local Codex or Claude sign-in commands and a check of
the saved connection. CLI sign-in must belong to the user running the worker;
Docker workers need access inside their container. API credentials are stored
privately on the worker and are not returned to the browser. Saving settings does
not prove successful authentication; a connection check does not establish
subscription quota or model access.

Operators can preview and import Docker Agent YAML as instruction/model profiles,
then select a definition and one named agent when creating a new task. The Run
task file editor has its own definition and agent selection. Import is
inert: it does not run Docker, tools, hooks or delegated teams. Unsupported
features are listed and require explicit instructions-only acceptance for that
task. Supported model selections require a matching worker provider. Each task
keeps its own definition snapshot, including instructions, model selection and
accepted omissions; later imports or removal do not change that snapshot. The
selected instructions and supported model are passed to the worker's provider.
An omitted or unsupported model uses that connection's configured model.

Chat keeps a searchable task rail and a readable transcript with code-copy
controls. Operators can draft a follow-up while a task runs, and send it when
that task finishes. A new task can wait behind the running task in the shared
single execution slot. Saved tasks and transcripts are shared by this worker's
operators; they are not personal account histories.

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

## Project-local feature requests

A worker can be initialized inside a project and started as a portable Node app
or a standalone Docker service. Setup provides a configurable feature folder and
an editable frontmatter-plus-Markdown request template. Drafts remain inactive;
ready files enter the existing serial queue after stable-save detection. Durable
IDs, immutable accepted input and admission replay prevent duplicate execution.
Lifecycle frontmatter, a queue summary and readable result/patch files support
operators who do not open the webview. Orchestrator assignments are mirrored into
the same folder while retaining orchestrator lease/routing authority.

The template and custom request metadata remain editable. One worker state owns
one folder; setup, native/Docker switching, recovery and copied-app operation
are documented in [project worker setup](docs/how-to/project-worker.md).
