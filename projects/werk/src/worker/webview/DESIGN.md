# Worker workspace direction

## THESIS

Operate mode. Preserve the slate/mint Vue and Nuxt UI identity. Every focused
view has exactly one user goal. Workboard, Projects, Workflow and Settings remain
the four primary navigation destinations; each opens focused child workflows.
Resource health and History remain secondary evidence destinations.

Workboard chooses the next request, with attention before waiting work. Creation,
conversation, project setup, evidence inspection and maintenance use their own
views. Supporting facts belong beside a decision; unrelated operations do not.
The route/goal catalogue is recorded in the
[dated review](../../../docs/reports/worker-ui-goals-2026-10-26.md).

Legacy taskboard/chat/session bookmarks retain exact request identity. Project
bookmarks resolve to the selected project or shared request. Earlier settings
bookmarks reach the appropriate independent editor or project workflow.
Home contains stable launchers, replaceable runtime, visible projects and private
state. New project-local installation is retired.

## OWN-WORLD

Extend Werk's dark slate and mint operational identity. Use readable system
typography, 44px controls, private credentials and honest simulation labels.
The surface describes one local worker and its configured execution capacity.
It shows observed concurrent work without implying a fleet or treating unresolved
capacity reservations as running models.

## STORY

A horizontal WorkerShell keeps Workboard / Projects / Workflow / Settings,
update state, Tour and Lock visible. Workboard (`/workboard`) answers which
request needs attention next. Needs you precedes review, active work and waiting
work, including on narrow screens. Compact status navigation reaches each lane.

**New Feature Request** opens `/requests/new` with project/draft identity retained.
It leads with the intended outcome, context, acceptance criteria, verification
and approved paths. Optional routing preferences disclose progressively. Prepare,
readiness and explicit Git publication serve that single authoring outcome;
request browsing and conversations open elsewhere.

`/request?session=<id>` opens the exact retained conversation and its valid
controls. `/request?project=<id>&request=<name>` handles the exact pre-admission
shared request and Ready Check. Review (`/review`) decides the exact current
increment. Required-check status and pending human acceptance are named
separately. Diff, current proof and the valid decision stay visible; historical
checks, detailed operation identities and execution traces disclose progressively.
`/request/maintenance?fileId=<id>` owns retained file-task priority, retry and
cleanup without turning History into task management.

Projects (`/projects`) chooses a project. `/projects/new` clones one remote into
the visible `Home/projects/<id>` path. `/project?project=<id>` keeps one project
identity while `step=workflow|policy|enable|edit|intake` opens one setup, approval,
readiness, policy-draft or request-polling goal. Approval keeps the exact baseline,
named providers, destination, limits and permitted exceptions with its explicit
acknowledgement. Recheck follows approval without asking the operator to remember
another project selector. Existing retained paths remain labelled honestly.

Workflow summarizes delivery health; `/workflow/evidence` owns quality cohorts.
Worker health (`/dashboard`) owns resources and invocation consumption, not
Feature Request outcome analysis. History provides mutually exclusive read-only
views. Browsing evidence never selects a session, restores an archive or changes
the queue. Links lead to the correct request/review/maintenance workflow.

One card retains one Feature Request identity across source, session and attempts.
Running state must agree with executor observations. Questions, rework, holds,
unknown outcomes and review actions remain visible. Candidate acceptance,
confirmed merge and release publication stay distinct.

Background updates preserve selection, focused controls and unsent authoring.
Unknown publication acknowledgement retains its immutable command identity;
reconciliation precedes another mutation. Source Markdown remains authoritative,
with generated progress and saved/error state explicit.

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

Settings opens a grouped directory, then one independent editor: Provider
connections, Default provider, Queue capacity, Execution time limits, Token allowance,
Tools & MCP, Agent instructions, Saved project authority, optional Execution profiles,
Orchestrator connection or Assigned request rules. Saved project authority permits global
revocation; project policy approval stays in the focused project workflow.
Central Home's earlier repository, integration and intake settings bookmarks
redirect to Projects or the scoped project. Retained Factory settings remain
available in their applicable context. Editors save separately and keep drafts
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

After unlock/setup, Workboard establishes the next request needing attention.
Creation and conversation open focused views with their own headings. Empty attention and queue areas
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
