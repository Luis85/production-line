# Worker workspace direction

## THESIS

Operate mode. One independently runnable worker, four primary pages: Taskboard
(default at `/taskboard`), Metrics (`/dashboard`), History and Settings (`/settings`).
An attention-first taskboard keeps task instructions and responses on the right.
Vue with Nuxt UI remains the implementation foundation. Request-scoped Review is
the delivery workspace reached from these pages. The worker shares a configured
machine execution ceiling across projects; stricter project limits and exclusive
unscoped operations govern which work can run concurrently.

The legacy `/chat` route redirects to `/taskboard` while preserving its query.
Metrics presents observations; Settings owns configuration. `/monitoring-status`
continues to open Metrics. Earlier Dashboard setup anchors open the corresponding
Settings sections. History remains the evidence and management surface.

## OWN-WORLD

Extend Werk's dark slate and mint operational identity. Use readable system
typography, 44px controls, private credentials and honest simulation labels.
The surface describes one local worker and its configured execution capacity.
It shows observed concurrent work without implying a fleet or treating unresolved
capacity reservations as running models.

## STORY

A horizontal WorkerShell keeps identity, Taskboard / Metrics / History / Settings
navigation, update state, Tour and Lock visible. After unlock, Taskboard answers
three questions: what needs the operator, what is running, and what is waiting.
A Running now strip follows observed active executor owners. Below it, a wider
Needs you area prioritizes checkpoint questions, decisions, request rework,
review and failed or interrupted attempts. Up next shows waiting work alongside
it. Completed and Drafts use disclosures beneath the active work.

One card represents one retained task across its session, local file task and
project-request projections. Preserve original task/session/request identifiers
and the source labels Local request, Assigned and Project request. Chat and file
execution remain distinct backend modes within Local request. Project
companion files do not transfer authority over remote assignments to the local
worker. Stale running records that disagree with the executor's active owners
need refresh, not duplicate running cards. Simulations remain labelled Simulated;
model completion is separate from review, acceptance, patch application or merge.

Selecting a task pins its identity above the right-hand interaction panel.
New request adds work; Follow up continues that selected task. This panel is for
task instructions, responses and checkpoint answers. Configuration, provider
login and worker administration belong in Settings. Empty states link to setup
when needed without turning task interaction into a settings form.

New request starts with Request instructions. Task options disclose the provider,
optional name and imported Docker Agent definition/agent. Repository files ·
optional grants bounded access to approved inputs within this same composer.
Create request always creates durable task tracking; the file permission is not
a switch for Markdown persistence. One idempotent create command owns the initial
instructions and permissions. If its acknowledgement is uncertain, keep that
exact command and expose Retry same request; never silently create another task.
Follow-ups retain the selected session and generated feature-request record.
Unsent drafts survive refresh, navigation and access expiry in this tab; explicit
Lock clears them and reload persistence is not promised.

Feature request Markdown shows the confirmed file, saved time and readable
progress. A pending or failed sync remains visible and retryable without implying
that accepted work was rejected. Source intake notes remain authoritative;
generated records never submit work or approve completion when edited. Keep
execution outcome, readiness/completion gates and patch review distinct.
History retains task management, source requests, patches and execution evidence.
Backend task kinds remain provenance, not separate primary creation journeys.

## MONITORING AND STEERING

The selected task exposes its observed state and retained provider/model evidence.
Label an invocation snapshot as recorded and a file-task or definition snapshot
as configured. Do not substitute current connection settings for an older run,
or treat the model from a completed attempt as the model of a new active turn.
If a provider uses an unspecified default, the actual model remains unknown.
Missing usage, cost, progress and provider telemetry remain unavailable. Metrics
starts with current activity and capacity, then token allowance beside worker and
host resources. Execution activity follows with outcome distribution, measured
duration, input/output tokens and reported cost. Runtime and connection diagnostics
remain in a disclosure. Taskboard, History and Settings links lead to their owned
workflows instead of adding configuration or task management to Metrics.

Current activity and the daily/monthly UTC allowance remain independent of the
execution selector: last 24 hours, 7 days, 30 days or all retained attempts. Its
window uses acceptance time and the default is 7 days. Preserve each response's
window labels; changing the selector clears the old summary. Attempts include
retries and reviews, not delivered Feature Requests. Show per-field measurement
coverage beside totals and average duration. Reported cost can include estimates;
unknown usage is not zero. Token allowance is configured worker policy, not
subscription balance or everyday usage outside this worker.

Resource meters show current observations with warning thresholds. Node process
CPU/RSS/heap exclude provider children; machine-wide memory includes other host
activity, and free disk space covers the state volume. No historical resource
chart is implied. Run evidence covers local invocations, while original remote
assignments retain their separate snapshot contract. Measurement age and failures
stay visible per source. Quiet background reads retain matching values and stable
buttons; freshness keeps aging while updates are paused. Lock and page lifecycle
changes fence late private responses, and cached-page re-entry refreshes its data.

Saved interaction events, checkpoints, transcripts and run evidence explain what
has happened. Structured questions and escalations release the execution slot;
answering them uses their revision-guarded controls. Current continuation replays
retained worker context in a fresh invocation. Live token streaming, native
provider-session resume and arbitrary changes to an in-flight prompt are not
advertised.

Keep three controls distinct:

- Stop task acts on the selected task's supported execution or checkpoint control.
- Pause new starts holds the shared queue while the active task finishes.
- Pause updates pauses this browser's automatic reads and changes no worker work.

A follow-up may be drafted while its task runs; sending waits until that task
finishes. New requests may queue behind it. Capacity shows the configured 1–8
machine slots, project limits, local admission occupancy including preparation
reservations, and the separate remote lease buffer. Unscoped operations remain
exclusive. Unresolved outcomes reserve slots without claiming live execution;
unadmitted ready notes do not count as occupied places. Fresh pause, preparation,
permission and consumption blockers explain why work waits; stale observations
never claim the worker is ready. No queue estimate implies an execution ETA.
Standalone is a healthy worker state. Queue capacity settings own the machine
ceiling; committed project policy can impose stricter concurrency limits.

## SETUP AND DEFINITIONS

Settings owns Providers & accounts, Queue & duration, Consumption, Tools & MCP,
Repositories, Shared request intake, Execution profiles, Agent definitions,
Project delivery, Project integration and Orchestrator. Editors save separately
and keep drafts
while navigating in the current tab. Queue/duration/consumption policy saves
compare the saved baseline; conflicts preserve the draft for reconciliation.
Metrics keeps operational diagnostics and links to the relevant editor. CLI
sign-in instructions name the worker machine and process owner. Configuration does not establish successful login,
subscription quota, model access or measured cost.

Agent YAML upload or paste leads to a preview of instructions, model and
unsupported features before import. Import does not execute Docker, tools,
hooks or delegated teams. New request requires explicit instructions-only acceptance
when unsupported features are omitted and surfaces provider mismatch before
creation. Each task retains its fixed definition snapshot, so later imports or
removal cannot silently change it. The same selection applies when the operator
allows changes to approved repository files.

## FIRST VIEWPORT

Before unlock, a dedicated access screen focuses on one token field, a visibility
toggle and Unlock worker. Local file guidance and expandable help distinguish
workspace access from provider sign-in. A separate HttpOnly session preserves
access across reloads for up to 12 hours; Lock, expiry or restart returns to
unlock. The durable access token is cleared after successful entry and is not
saved in browser storage, the session cookie or a URL. Running tasks continue
on the worker when browser access locks.

After unlock, the board and right-hand interaction panel establish the worker's
current work immediately. Empty attention and queue areas explain their state;
no placeholder task, model name or fabricated progress is presented as real.
The selected task remains clear while the operator drafts instructions or reads
output. A persistent Tour explains the four pages and their controls without
configuring providers, enrolling the worker or submitting work.

## FORM

Use native Nuxt UI controls and authored two-dimensional layout. The horizontal
header and board retain the existing slate surfaces, mint action color and
readable hierarchy. Wide screens place the board beside the narrower interaction
panel; within the board, Needs you has more space than Up next. Small screens
stack board and interaction without losing the selected task or requiring drag
and drop. Native buttons and links provide keyboard equivalents for every action.

Task names and model/provider labels wrap. Status always includes text rather
than relying on color. Transcript replies support paragraphs, lists, emphasis,
inline code and fenced code with Copy code. Model output remains text, not
interpreted HTML; long code scrolls inside its block. Evidence and secondary
settings disclose progressively. Background updates preserve selection, drafts,
focus and reading position; explicit user navigation may move focus to its target.

## FINISH

Keep route labels and capability limits aligned with the actual workspace.
Record dated review evidence separately: this design direction does not claim a
build has passed browser review or live-provider verification. Preserve keyboard
focus, narrow-screen navigation, stale-data feedback, private access and unsent
work. Implementation requests edit an owned worktree and run their configured
required project checks; legacy proposal requests retain their accepted contract.
Review artifacts identify the candidate and evidence. Neither passing checks nor
human acceptance silently merges changes into the developer's checkout.

## Shared Vue foundation

The worker's horizontal shell frames shared access, connection and guided-tour
components from `src/shared/webview` and the shared Werk theme. Credential
handling, refresh state and task drafts remain in the worker store; route pages
retain their `KeepAlive` lifecycle. Shared polling skips hidden or paused views
and prevents overlapping scheduled reads. Tours use Nuxt UI focus management,
await route activation before highlighting a target and close when access locks.
Shared skip links focus main content without changing hash-based routes used by
other Werk applications. Taskboard aggregation is a pure view of retained worker
state; it does not introduce a second task queue or execution authority.

## Repository consent and profile editing

A detected installation repository appears in a nonmodal prompt above the
taskboard and in Settings → Repositories. Show its full wrapping path,
branch and remote name without remote credentials. Use repository and Don’t use
are explicit choices; the latter persists and leaves a reconsideration action
in Settings. Pending actions, failures and acknowledged choices have visible
feedback without stealing focus during polling.

Execution profiles have a focused Settings editor with labelled ID/provider
fields, add/remove controls and a visible execution-mode boundary. Keep drafts
while live observations refresh, report stale saves before overwriting changes,
and distinguish saved pending synchronization from active profiles. Explain
pause/drain requirements next to the save controls and distinguish advertised
orchestrator profiles from project delivery profiles and machine capacity.
Provider sign-in and model settings remain in Provider connections.
