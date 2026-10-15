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

The worker uses Vue with Nuxt UI and three primary pages: Taskboard, History
and Dashboard. Taskboard (`/taskboard`) opens after unlock. The selected third
mockup direction puts the task overview first: a Running now strip above an
asymmetric Needs you / Up next board, with Completed and Drafts disclosed below.
Chat tasks, approved-file tasks, assigned work and project requests retain their
source labels and identifiers without appearing as duplicate cards.

A task-scoped interaction panel sits to the right. Its New task and Follow up
modes add work or continue the selected task; the panel does not become a general
assistant or a configuration workspace. History retains conversations, file-task
management, project requests and execution evidence. Dashboard carries health,
environment, provider connections, agent definitions and optional orchestrator
enrollment. The legacy `/chat` route redirects to `/taskboard` while preserving
its query; `/monitoring-status` continues to redirect to `/dashboard`.

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
file tasks and remote assignments also receive dedicated sessions. The UI handles
creation and the first message as one submission workflow, dispatching only to
the returned session ID. These remain separate server requests: if the first
message is not confirmed, retain the instructions with the created task and ask
the operator to inspect its conversation before retrying. Do not silently create
a second task or claim that an ambiguous submission was rejected.

Stop task targets the selected execution or checkpoint. Pause new starts holds
the shared queue while the active task finishes. Pause updates only pauses this
browser's automatic reads. None of these controls is a live edit to an in-flight
model prompt. The worker is the only component that prompts an LLM; Factory and
orchestrator own routing, not model execution. The taskboard retains access to
the file-task editor for approved inputs and review patches.

## Worker Provider and Agent Definitions

Provider connections belong to the worker. Dashboard owns saved connection
settings, local Codex or Claude sign-in commands and checks of saved connections.
Taskboard links there when a connection needs setup. CLI sign-in must belong to
the user running the worker;
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

The taskboard keeps the selected task visible beside its conversation. Needs you
prioritizes checkpoint questions, decisions, request rework, review and failures;
Up next shows waiting work. Only the observed shared executor owner appears as
Running now. Completed model turns, human acceptance and applied patches remain
separate facts. Stopped work is labelled Stopped; mock execution is labelled
Simulated and never presented as an implementation.

The interaction panel shows the selected task identity, readable transcript and
code-copy controls. Operators can draft a follow-up during execution and send it
when that task finishes. Questions and escalations use their explicit checkpoint
controls. Saved events and execution evidence support monitoring; live token
streaming, native provider resume and arbitrary mid-run steering are not implied.

Provider/model readings distinguish retained invocation evidence from configured
file-task or agent snapshots. A previous completed attempt cannot establish the
model of a new running turn, and an unspecified provider-default model remains
unknown. Unreported usage, cost and progress stay unavailable rather than being
estimated. On narrow screens, board and interaction controls stack while retaining
selection, readable task names and keyboard access. Unsent drafts survive normal
refresh, navigation and access expiry in the current tab; page reload and explicit
Lock do not promise draft persistence. Saved tasks and transcripts are shared by
this worker's operators, not personal account histories.

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


## Local execution evidence and analysis

A project worker preserves durable per-invocation run evidence for local chat,
approved-file tasks and feature requests. Before invoking a provider, it records
state, worker-process resources and cumulative known consumption after acquiring
the shared execution slot. A matching terminal observation records the same
fields, plus per-run reported usage and measured duration. Queued cancellation
and crash recovery stay explicit; they do not invent execution measurements.

Run history survives session deletion and restart. History exposes project
requests, run inspection, filtered analysis and export; the portable CLI exposes
the same records for humans and agents. Bounded pages never imply bounded
aggregate totals. Unknown usage/cost remains null and totals include per-field
coverage. Cache tokens are subsets of input; provider-reported USD includes cost
provenance and can be an estimate. It is not a subscription balance or quality
measurement. Remote assignment
snapshots remain under their existing orchestrator evidence contract.

## Durable worker–model interactions

The local worker saves an immutable semantic dispatch before invoking a provider.
Adapters expose one versioned request/result/capability contract. Structured
questions and escalations release the execution slot and remain on the owning
request until answered or cancelled through revision-guarded operations. Stable
operation keys deduplicate accepted commands after lost acknowledgements.

The task interaction panel and CLI expose checkpoint inspection and explicit
continuation. Current adapters use saved worker context in a fresh invocation; native provider session
resume and live token streaming are not advertised. A durably saved result is
reconciled after restart without another model call; ambiguous in-flight work
stays interrupted. A content-free durable event feed lets clients replay lifecycle
changes independently of provider formats. See the
[interaction contract](docs/reference/model-interaction.md).
