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

The worker uses Vue with Nuxt UI and four primary pages: Taskboard
(`/taskboard`), Metrics (`/dashboard`), History (`/history`) and Settings
(`/settings`). Taskboard opens after unlock. It keeps current work, Needs you
and Up next beside a task-scoped interaction panel; completed work and drafts
remain available without duplicating task identities across sources.

New request starts with the operator's instructions. Task options disclose the
provider, optional name and reusable agent definition. Follow up continues the
selected task. Taskboard shows execution and admission capacity. Metrics visualizes
this worker's current capacity, token allowance, resources and retained execution
activity. History retains conversations, review patches
and execution evidence; Settings
owns provider accounts, queue/duration policy, tools, repositories, shared intake,
profiles and optional orchestrator enrollment.

The legacy `/chat` route preserves its query when redirecting to Taskboard.
`/monitoring-status` opens Metrics; earlier Dashboard setup bookmarks redirect
to their corresponding Settings sections.

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
Local admission counts queued/running chat and file work, including preparation
reservations. Accepted remote assignments use a separate buffer; ready notes not
yet admitted are not occupied places. These counts never add execution slots.
Stale observations do not establish availability. Separate Feature Requests need
separate worker instances for parallel execution, each with its own state and
webview port. Within one attempt, an explicitly granted parent model can use
bounded child sessions. Those children keep the same request and grants, share
its tool-call/time budget, and count toward the worker allowance.

Every task owns a dedicated worker-managed session and an automatically maintained
Markdown feature-request record. Follow-ups, answers and retries keep that record.
A request retains its logical model session across invocations; native resume and
worker context replay are distinct adapter capabilities. Shared project context
comes from an explicit committed manifest, while private conversation history
remains request-specific.
The unified interaction starts with instructions; approved repository-file work is
an optional permission, never an opt-in to persistence. Source notes retain their
own intake authority; the generated record reports progress without replacing them.

Creation and admission remain distinct from Markdown synchronization. An accepted
task stays accepted if its record needs saving or a write fails; show that state
and retry synchronization without creating duplicate work. Confirm a saved record
only after its write succeeds. New request sends one idempotent create command
with a stable identity and the original instructions/permissions. An uncertain
acknowledgement retains that exact command for Retry same request; it must not
silently create new work or substitute edited input.

Stop task targets the selected execution or checkpoint. Pause new starts holds
the shared queue while the active task finishes. Pause updates only pauses this
browser's automatic reads. None of these controls is a live edit to an in-flight
model prompt. The worker is the only component that prompts an LLM; Factory and
orchestrator own routing, not model execution. Repository-file approval lives in
the same task interaction; generated patches still require human review.

## Feature Request Review

Review is a request-scoped page reached from the Taskboard, conversation or History.
Accepted scope, changes, current checks, human decisions and shared publication
appear together with one next valid action. It projects existing request authority;
it never creates a parallel lifecycle. Inconsistent ownership or stale evidence
blocks decisions. Read-only inspection does not select another conversation.
Acceptance, implementation completion and a Git merge are distinct events.

## Worker-owned Processes

Development services require explicit fixed presets, a bounded lifetime and restart
budget. They belong to one Feature Request and its pinned worktree. Successful model
turns may leave them running for review; cancellation, failed work, revoked grants,
archive, lifetime expiry and shutdown stop the owned service. Model and UI controls
use opaque service identities, never arbitrary process IDs or command arguments.

Metrics shows owned services and finite process observations with separate scope,
resource coverage and retention. Service logs are bounded. An unavailable sample is
not zero usage, a live process is not a health check, and services do not add task
execution slots. The webview provides explicit stop/restart decisions with conflict
and uncertain-response recovery.

## Worker Settings

Settings sections save independently and retain unsaved edits while navigating
in the current tab. Queue, duration and consumption editors compare the saved
baseline before replacing policy; another operator's change produces a conflict
instead of an unseen overwrite. A lost acknowledgement requires inspecting the
saved result before retrying. Existing requirements to pause or drain work still
apply where needed before changing providers, repositories, profiles or tools.

## Worker Metrics

Metrics brings current activity, the configured UTC token allowance and resource
observations together for this worker. Reported tokens, reservations and remaining
allowance stay distinct; the budget is not a provider subscription balance and
excludes everyday usage outside the worker. Resource meters distinguish worker
Node-process CPU/RSS/heap from whole-host memory and state-volume free space.
The process section separately observes finite model/tool/MCP/Git groups and
explicitly granted development services. Resource coverage remains visible; no
historical resource time series or complete provider-account consumption is implied.

Execution activity offers acceptance-time windows of 24 hours, 7 days, 30 days or
all retained attempts. It shows outcomes, average measured duration, reported
input/output tokens and cost with coverage. Attempts include follow-ups, retries
and reviews, so they do not count delivered Feature Requests. Unknown measurements
remain unavailable and reported cost may be an estimate. Original remote lease
execution keeps its separate evidence contract.

Each source exposes freshness and failed reads retain clearly marked last values.
Background updates keep controls stable; pausing reads does not freeze measurement
age. Configuration stays in Settings, detailed evidence and export in History,
and current work in Taskboard. See the
[metrics reference](docs/reference/worker-run-metrics.md#metrics-webview).

## Worker Provider and Agent Definitions

Provider connections belong to the worker. Settings → Providers & accounts owns
saved settings, local Codex or Claude sign-in commands and checks of saved connections.
Taskboard links there when a connection needs setup. CLI sign-in must belong to
the user running the worker;
Docker workers need access inside their container. API credentials are stored
privately on the worker and are not returned to the browser. Saving settings does
not prove successful authentication; a connection check does not establish
subscription quota or model access.

Operators can preview and import Docker Agent YAML as instruction/model profiles,
then select a definition and one named agent when creating a request, with or
without approved repository files. Import is inert: it does not run Docker, tools,
hooks or delegated teams. Unsupported
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
operators who do not open the webview. These intake files are distinct from the
automatic per-task Markdown progress records, which exist even without a watched
feature folder. Orchestrator assignments are mirrored into
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

## Repository consent and execution profiles

On startup, a worker inspects its installation/project folder for an exact Git
checkout, including linked worktrees. An unassigned detected repository appears
as an optional consent prompt after unlock. Accepting adds a repository assignment;
watching starts only when a branch and remote are available. Coding tasks use
retained worktrees. Declining is remembered across restarts and can be reconsidered
in Settings → Repositories. Detection does not search parent folders or contact
remotes.

Settings → Execution profiles edits profile IDs and providers within the worker’s
configured execution mode. Profiles share one execution slot. Changes require
paused intake and no queued or active work; registered workers retain their
identity and history while synchronizing the change with their orchestrator.
A saved pending change blocks new admission until acknowledged. Execution profiles
remain separate from provider connections, model settings and agent definitions.

## Worker-managed model tools

Settings → Tools & MCP provides default-off grants for task-worktree
files, fixed command presets, project CLI tools with an argument policy, allowed
web origins and individually selected MCP tools. MCP connections support stdio
and HTTP, private credentials and explicit discovery.
Grants are enforced through a common worker-owned catalog across supported local
provider adapters. Operators pause and drain execution before saving; subsequent
turns use the current policy, while saved dispatch evidence remains immutable.
Operators set invocation budgets and optional per-grant timeouts so models can
run long project checks such as unit tests. Command and CLI overrides remain
capped by the accepted global command ceiling; every call remains bounded by
the total invocation deadline. Tool results go to the selected model provider.
Commands and MCP servers retain their account/service authority. Automated request reviewers remain tool-free.
See [manage model tools](docs/how-to/manage-model-tools.md).

## Verified feature implementation

A new Git-backed request with explicit approved paths, file access and enabled
required verification presets can implement a feature in its isolated worktree.
The model inspects, edits, runs checks and repairs failures through the shared
worker tool broker. Candidate digests and frozen command fingerprints bind
verification to the actual review patch. New edits require fresh checks. Existing
proposal requests retain their accepted contract.

The UI explains available implementation capability before submission and shows
the accepted mode, retained candidate, required checks and blockers afterward.
Markdown progress and shared review notes retain human-readable verification
evidence. Successful checks do not authorize a merge. Tool-call and command
timeout limits are configurable separately from the total invocation duration.
See [implement a feature](docs/how-to/implement-feature.md).
