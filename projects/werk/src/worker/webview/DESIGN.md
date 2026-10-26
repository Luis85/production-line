# Worker workspace direction

## THESIS

Operate mode. One central WerkHome with four primary pages: Workboard
(default at `/workboard`), Projects (`/projects`), Workflow (`/workflow`) and
Settings (`/settings`). Metrics and History remain secondary evidence links.
Vue with Nuxt UI remains the implementation foundation. Workboard leads with
Feature Requests, live progress and review; request-scoped Review leads with
changes, checks and the current human decision.

The legacy `/taskboard` and `/chat` routes redirect to `/workboard` preserving
queries. `/monitoring-status` continues to open Metrics; prior setup bookmarks
open Settings. Home contains stable launchers, replaceable runtime, visible
projects and private state. New project-local installation is retired.

## OWN-WORLD

Extend Werk's dark slate and mint operational identity. Use readable system
typography, 44px controls, private credentials and honest simulation labels.
The surface describes one local worker and its configured execution capacity.
It shows observed concurrent work without implying a fleet or treating unresolved
capacity reservations as running models.

## STORY

A horizontal WorkerShell keeps Workboard / Projects / Workflow / Settings,
update state, Tour and Lock visible. After setup, Workboard answers what needs the
operator, what is running and what is waiting across the delivery stages.
**New Feature Request** opens the project's committed-template authoring flow on
demand: prepare, inspect/edit, check readiness and publish to Git before execution.
It does not dispatch generic local chat as the primary request journey.

Projects is one click away and exposes visible `Home/projects/<id>` repositories,
remote branch, watched folder/poll interval, setup status and next action. Provider
configuration stays directly reachable in Settings. Existing retained paths are
labelled honestly; they are not silently moved. The Home itself is never inferred
to be a project checkout.

One card retains one Feature Request identity across source, session and attempts.
Running state must agree with executor observations. Questions, rework, holds,
unknown outcomes and review actions stay visible without requiring transcripts.
Review prioritizes diff, independent checks and current-candidate human outcomes;
verbose operation identities and execution traces are secondary disclosures.
Candidate acceptance, confirmed merge and release publication remain distinct.

Background updates preserve selection, focused controls and unsent authoring.
Unknown publication acknowledgement retains its immutable command identity;
reconciliation precedes any new mutation. Source Markdown remains authoritative,
with generated progress and saved/error state explicit. Metrics and History retain
attempt/resource measurements and detailed evidence without competing with the
primary Feature Request workflow.

## WORKFLOW EVIDENCE

Workflow starts with persisted Feature Request stages and stage pressure, then
UTC-week delivered-increment velocity and measured lead/cycle durations. Project
and time filters retain their scope across sections. Completion targets distinguish
human acceptance, main-checkout merge and release publication. Velocity requires
confirmed integration; review-only closure, provider attempts, passing checks and
an internal completed phase do not establish delivered increments.

The four Evidence-based management areas expose the limits of the observations.
Delivery timing can inform Time to Market; no chart manufactures Current Value,
Unrealized Value, innovation outcomes or a quality score from activity counts.
Unknown and incomplete-history coverage belongs beside each measure. Empty data,
failed reads and stale retained observations have distinct messages. Charts retain
text labels and accessible tabular facts; narrow screens preserve filter labels,
evidence identity and 44px controls. The existing slate/mint system remains.

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
remain in a disclosure. Workboard, History and Settings links lead to their owned
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

After unlock/setup, the full-width Workboard establishes current Feature Requests,
live progress and review actions immediately. Empty attention and queue areas
explain their state;
no placeholder task, model name or fabricated progress is presented as real.
The selected task remains clear while the operator drafts instructions or reads
output. A persistent Tour explains the four primary pages and their controls without
configuring providers, enrolling the worker or submitting work.

## FORM

Use native Nuxt UI controls and authored two-dimensional layout. The horizontal
header and board retain the existing slate surfaces, mint action color and
readable hierarchy. Wide screens use the available width for delivery stages;
small screens retain request identity, stage labels and next actions without
requiring drag and drop. Native buttons and links provide keyboard equivalents.

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
other Werk applications. Workboard aggregation is a pure view of retained worker
state; it does not introduce a second task queue or execution authority.

## Repository consent and profile editing

Projects owns remote-clone registration and displays the visible Home path,
selected branch, watched folder/poll interval and setup recovery. It does not
infer Home to be a repository or offer arbitrary existing-checkout adoption.
Retained legacy paths remain labelled and unchanged. Pending actions and failures
have visible feedback without stealing focus during polling.

Execution profiles have a focused Settings editor with labelled ID/provider
fields, add/remove controls and a visible execution-mode boundary. Keep drafts
while live observations refresh, report stale saves before overwriting changes,
and distinguish saved pending synchronization from active profiles. Explain
pause/drain requirements next to the save controls and distinguish advertised
orchestrator profiles from project delivery profiles and machine capacity.
Provider sign-in and model settings remain in Provider connections.
