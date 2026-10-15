# Worker workspace direction

## THESIS

Operate mode. One independently runnable worker, three primary pages: Taskboard
(default at `/taskboard`), History and Dashboard. The selected third mockup
establishes an attention-first taskboard with a task interaction panel on the
right. Vue with Nuxt UI remains the implementation foundation. One worker
executes exactly one task at a time; additional workers provide parallelism.

The legacy `/chat` route redirects to `/taskboard` while preserving its query.
Dashboard includes Monitoring & Status and setup; `/monitoring-status` continues
to redirect to `/dashboard`. History remains the evidence and management surface.

## OWN-WORLD

Extend Werk's dark slate and mint operational identity. Use readable system
typography, 44px controls, private credentials and honest simulation labels.
The surface describes one local worker and its shared execution slot. It does
not imply a fleet or several simultaneously running models.

## STORY

A horizontal WorkerShell keeps identity, Taskboard / History / Dashboard
navigation, update state, Tour and Lock visible. After unlock, Taskboard answers
three questions: what needs the operator, what is running, and what is waiting.
A Running now strip follows the current shared executor owner. Below it, a wider
Needs you area prioritizes checkpoint questions, decisions, request rework,
review and failed or interrupted attempts. Up next shows waiting work alongside
it. Completed and Drafts use disclosures beneath the active work.

One card represents one retained task across its session, local file task and
project-request projections. Preserve original task/session/request identifiers
and the source labels Chat, File task, Assigned and Project request. Project
companion files do not transfer authority over remote assignments to the local
worker. Stale running records that disagree with the shared execution slot need
refresh, not a second running card. Simulations remain labelled Simulated; model
completion is separate from review, acceptance, patch application or merge.

Selecting a task pins its identity above the right-hand interaction panel.
New task adds work; Follow up continues that selected task. This panel is for
task instructions, responses and checkpoint answers. Configuration, provider
login and worker administration belong in Dashboard. Empty states link to setup
when needed without turning task interaction into a settings form.

New task selects a provider and, optionally, an imported Docker Agent definition
and named agent. One UI submission coordinates creating a dedicated worker-owned
session and sending the first message to its returned session ID. These are
separate server requests, not a transactional backend operation. If creation
succeeds but the first-message result is unconfirmed, preserve the created task
and instructions and direct the operator to inspect the conversation before
retrying. An uncertain creation must not trigger an automatic duplicate create.
Follow-ups retain the selected session. Unsent drafts survive normal refresh,
navigation and access expiry in the current tab; reload persistence is not
promised, and explicit Lock clears them.

The file-task editor remains available for approved local inputs and produces
a review patch in its own session. Remote assignments also retain dedicated
sessions. History lists every task type, archived records, project requests,
file-task management and retained execution evidence. Its existing review and
inspection actions remain the route to evidence rather than a new board-specific
record store.

## MONITORING AND STEERING

The selected task exposes its observed state and retained provider/model evidence.
Label an invocation snapshot as recorded and a file-task or definition snapshot
as configured. Do not substitute current connection settings for an older run,
or treat the model from a completed attempt as the model of a new active turn.
If a provider uses an unspecified default, the actual model remains unknown.
Missing usage, cost, progress and provider telemetry remain unavailable.

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
finishes. New tasks may queue behind it. Queue capacity is not execution capacity.
Standalone is a healthy worker state. Scale parallel work with separate native
or Docker workers, never a per-worker concurrency control.

## SETUP AND DEFINITIONS

Dashboard owns provider connections, saved connection checks, Docker Agent
definitions, enrollment and diagnostics. CLI sign-in instructions name the worker
machine and process owner. Configuration does not establish successful login,
subscription quota, model access or measured cost.

Agent YAML upload or paste leads to a preview of instructions, model and
unsupported features before import. Import does not execute Docker, tools,
hooks or delegated teams. New task requires explicit instructions-only acceptance
when unsupported features are omitted and surfaces provider mismatch before
creation. Each task retains its fixed definition snapshot, so later imports or
removal cannot silently change it. The file-task editor has its own definition
and agent selection.

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
output. A persistent Tour explains the three pages and their controls without
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
work. Local tasks produce review artifacts from approved inputs; they do not
apply patches or run project tests automatically.

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
taskboard and in Dashboard’s repository section. Show its full wrapping path,
branch and remote name without remote credentials. Use repository and Don’t use
are explicit choices; the latter persists and leaves a reconsideration action
in Dashboard. Pending actions, failures and acknowledged choices have visible
feedback without stealing focus during polling.

Execution profiles have a focused Dashboard editor with labelled ID/provider
fields, add/remove controls and a visible execution-mode boundary. Keep drafts
while live observations refresh, report stale saves before overwriting changes,
and distinguish saved pending synchronization from active profiles. Explain
pause/drain requirements next to the save controls and keep one-slot semantics
explicit. Provider sign-in and model settings remain in Provider connections.
