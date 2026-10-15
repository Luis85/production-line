---
name: Werk
description: Existing operational palette and shared spatial components
colors:
  background: "#111b22"
  foreground: "#edf4f7"
  secondary: "#b5c4cd"
  border: "#3b4b56"
  mint: "#8be0b8"
  blue: "#81b6ee"
  amber: "#edc47e"
  spatial-stage: "#132129"
  spatial-inspector: "#17262f"
  spatial-selected: "#213d35"
typography:
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "16px"
    lineHeight: 1.6
rounded:
  spatial: "12px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-6: "24px"
  space-8: "32px"
  space-12: "48px"
components:
  spatial-inspector:
    backgroundColor: "{colors.spatial-inspector}"
    textColor: "{colors.foreground}"
    padding: "24px"
  spatial-selection:
    backgroundColor: "{colors.spatial-selected}"
    textColor: "{colors.mint}"
---

# Werk design record

## Product entry and capability boundary

Factory opens an aggregate dashboard for its selected hierarchy scope. Each
registered line has its own Factory dashboard (`#line=<id>`) and a separate link
to its independent orchestrator. The orchestrator opens Dashboard (`#system`),
including the live line map, by default after authentication. Explicit `#intake`, `#tasks`, `#workers` and `#metrics` links open
their requested area after connection. Factory shows its durable intake delivery
queue; line execution history and taskboards remain with their orchestrators.
Workers, orchestrators and Factories can start independently and connect later.
The main journey
is connect → understand the line → hand over ready features → follow task
execution → inspect evidence. Product teams normally
plan in Obsidian, create an iteration branch/draft PR and import ready features.
Lightweight intake accepts one requirement wikilink in the selected project.
Title and criteria remain in the source note; unresolved references are labeled
honestly in mock execution. Detailed manual intake remains an alternative.

The orchestrator's operational webview reads persisted SQLite task state through
HTTP; its spatial map shows those live observations and their freshness. The
separate `/concept` demo simulates the target PR lifecycle using browser state.
Both explicitly distinguish mock completion from feature implementation,
human acceptance and merge. Do not route a concept action into the live API or
show simulated metrics as measured provider performance.

## Visual system

Spacing scale: 4, 8, 12, 16, 24, 32, 48px. The Factory, orchestrator, worker and concept views use `--space-*`
variables, with page=32, panel=24, section=32, field=16 and inline=8px roles.
At <=760px, page/panel=16 and section=24px. Selectors are consolidated by
component and viewport; avoid a stack of corrective overrides.

Operational surfaces: background #111b22, text #edf4f7, secondary #b5c4cd,
borders #3b4b56, action mint #8be0b8; system sans-serif 16px/1.6. Runtime controls
have a 44px minimum height. At desktop widths of at least 1100px, the shared
spatial layout expands orchestrator content to 1540px and Factory content to
1760px. The worker has a Vue/Nuxt UI workspace with three primary pages:
Taskboard (default at `/taskboard`), History and Dashboard. Its horizontal worker
header frames the selected third mockup direction: Running now above an
asymmetric Needs you / Up next board, Completed and Drafts disclosures, and a
right-hand task interaction panel. Dashboard contains Monitoring & Status and
setup. `/chat` redirects to `/taskboard` with its query preserved;
`/monitoring-status` redirects to `/dashboard`. Tables scroll when necessary
instead of compressing identity and evidence beyond readability. The worker
surface's composition is recorded in `src/worker/webview/DESIGN.md`.

Concept surfaces: background #10191e, panels #17232b, lines #30404a,
foreground #e8efee, secondary #a1b2bc. Project colors: mint #8be0b8, blue #81b6ee,
amber #edc47e. The spatial interface shares the 44px standard-control baseline and a responsive
inspector. Color encodes project identity separately from textual health/status.

## Factory topology and drill-down

The concept Factory view starts with a nested production map. Boundary nesting
shows Factory ownership; each line contains one orchestrator, its own workers
and its project repository. Selection reveals capacity and provider details;
explicit actions open that line's Intake, spatial architecture or review queue.
The original 3D canvas remains the detailed view of one production line.

The operational Factory view starts on an aggregate dashboard with observed
totals and a canvas map offering orthographic 3D and 2D representations, a
contextual inspector and native component-selection buttons. A dashboard selector
opens the selected line's own process map, counts, interaction widget and link to
the owning orchestrator. Scope and line identity remain explicit. Connections and table alternatives retain the same scoped response.
The map is bounded to the first 12 lines and 20 factories in the selected scope;
the scope selector and full registry/table remain available. It shows one
orchestrator and an aggregate worker pool per line, grouped by the owning Factory path. Do not invent individual workers
or repositories from the current summary API. Unknown/stale/partial observations
remain explicit; changing representation never changes the data timestamp.

Spatial components use world-coordinate geometry: each visible face, detail and
ground connection is projected through the same orthographic camera. Factories,
line platforms, orchestrators, worker pools, profiles and evidence use distinct
schematic forms. Those forms encode component type, never instance counts or
additional inventory. Depth ordering and consistent face shading communicate
structure. Labels reserve space outside all model bounds and other labels; short
leader lines retain association where a label cannot sit immediately adjacent.
Dense scenes scroll within a bounded viewport instead of shrinking labels away.
The 2D representation retains the same entities, selection and observations.

The shared runtime and guide map uses native controls, descriptive grouping and
keyboard alternatives for diagram selection. Pointer dragging rotates the 3D
projection; named camera buttons rotate, zoom and reset it. Touch gestures and
native arrow-key scrolling pan the bounded diagram in both modes; Home resets
the camera. The inspector sits beside the diagram above 1100px, below it at
smaller widths, and becomes a single column at 760px and below. Camera controls
are disclosed separately and start collapsed on mobile. Canvas graphics are
supplemented by HTML selection controls, facts and actions. Long labels wrap in
detail views; the precise concept map scrolls when necessary. See `docs/handoff/visualization-spec.md` for the complete
UI handoff and browser acceptance checks.

## Interactions

A single vault requirement link leads runtime Intake; optional manual fields
and iteration-import guidance are progressively disclosed. Intake pairs a focused
editor with a local preview of the planned task and its execution mode. A saved
task has a direct route to its detail, events and scoped snapshots. The taskboard
groups the current filtered page by status; the original table remains available.
Task details present an event timeline, and snapshots present readable facts,
with full JSON retained behind disclosures. Worker cards lead to a map of the
observed worker, its profiles and bounded active-task detail response; this is
read-only configuration context. Opening a saved task clears
filters that could hide it. The concept also supports weekly ready-import and
keeps unsent feature drafts scoped to the selected production line. Factory
management shows portfolio context; line operations show the selected line.
Worker Taskboard is the first work surface after unlock. Cards combine session,
file-task and project-request records by retained identity, preserving Chat,
File task, Assigned and Project request labels. Needs you makes questions,
decisions, rework, reviews and failures prominent; Up next shows queued work.
The Running now strip follows the shared executor's current session. Completed
and Drafts are secondary disclosures. The layout does not use several apparently
active columns to imply parallel execution.

The right-hand panel offers New task and Follow up for the selected task.
Submitting a new task creates one worker-owned session and sends its first
message to the returned session ID. The UI coordinates these separate requests;
an uncertain first-message acknowledgement keeps the draft and created identity
for inspection rather than silently creating another task. Follow-ups preserve
that identity. Explicit file tasks and remote assignments also own dedicated
sessions. The file-task editor remains the path for approved local file inputs.
History retains task management and execution evidence without taking authority
over orchestrator-owned assignments. Dashboard holds provider and agent setup,
enrollment, process health and diagnostics outside the task interaction panel.

One worker has exactly one execution slot shared by chat, explicit file tasks
and remote assignments. Queue capacity never implies parallel execution. Stop
task stops the selected task through its supported controls. Pause new starts
holds every new execution start while the active task finishes; it does not
interrupt that model or drain waiting assignments. Pause updates stops automatic
browser reads only. Scale parallel work with separate native or Docker workers.
Only the worker prompts an LLM; Factory and orchestrator route work.

Monitoring distinguishes recorded provider/model snapshots from configured
file-task or definition snapshots. Missing actual model, usage, cost and progress
remain unavailable; a previous attempt's model is not evidence of a new running
turn's model. Saved events, checkpoints and retained run evidence explain observed
state. Live prompt edits, native provider resume and token streaming are not
advertised. Local file-change tasks produce review patches without silently
applying changes or running project tests. Simulation remains explicitly labelled.

Connection, loading, stale data and empty filters are distinct states. Operator
tokens never enter URLs or browser storage. Factory/orchestrator views and their
interaction widgets retain entered tokens in page memory. The worker exchanges
its entered token for a separate bounded HttpOnly browser session, then discards
the entered token; its dedicated unlock screen returns after expiry or restart. Unsent orchestrator
intake drafts remain in page memory while navigating and reconnecting. Live updates can be
paused and preserve selection/filter context. User navigation moves focus appropriately; background updates do not.
Modal editors and interaction widgets isolate the background and restore trigger
focus. Guided tours are replayable, non-modal walkthroughs with explicit Back,
Next, Finish and Close controls; they navigate or disclose UI without submitting
work. Closing a tour restores its trigger when that control remains present. Reduced motion and
keyboard-equivalent actions remain requirements for the spatial view.

Factory intake and orchestrator routing expose automatic and manual destinations.
Manual selections keep compatibility and capacity constraints visible. Factory
intake distinguishes queued, delivering and delivered: delivery means the line
accepted a task, not that execution or review succeeded. Once delivery begins,
retries retain the same destination and idempotency key. Existing worker leases
also retain their destination when routing policy changes.

Line and orchestrator interaction widgets offer worker-backed New task/Chat and
a separate routed Submit task action. The widget requests the worker URL and its
access token, connects to that registered worker's selected task session, and
keeps credentials in dialog memory. New task's first message queues work on that
worker; follow-ups keep the same session. Submit task follows line routing and
may select another eligible worker. Closing the widget clears its connection. Provider settings
never stand in for evidence of successful authentication, quota or cost.

The concept canvas uses pointer rotation, zoom, pan and equivalent buttons.
Its state model separates transitions, UI adaptation and spatial rendering;
it retains demo state locally and reports storage failures. Runtime webviews
use HTTP server authority and never depend on the concept localStorage state.

The standalone guide reuses the spatial component with explicitly illustrative
data. Its local YAML composer prepares one line with one to eight workers for
native or Docker mock execution. Downloading a definition does not start a
service, apply a configuration or migrate existing state. This guided one-line
example does not change the native launcher's default two independent lines.

## Evidence and review

Dashboard summaries disclose sample count, selected scope and bounded history.
Unknown cost/quality stays unknown. Process CPU/RSS may overlap for concurrent
attempts. Snapshot pair completeness is observed evidence, not fleet-wide proof.
A mock execution cannot satisfy the target human-review/merge definition of done.

The initial design pass used source inspection and functional/static tests; it
had no browser, Docker or Windows execution evidence. That is a historical limit,
not a description of the current release qualification. Later browser captures
and runtime checks are recorded in the dated [review history](docs/reports/index.md)
and [first-release review](docs/reports/first-release-review.md). Native platform,
Docker and VM claims depend on the candidate's completed
[qualification gates](docs/reference/releases.md#candidate-qualification-gates).
Screenshots establish the captured layout and state; keyboard focus, zoom, touch
and contrast require their own checks and should be claimed only when recorded.

Detailed user journey and token rules: [UI journey](docs/explanation/ui-journey.md).
Imported visual handoff documents describe their original baseline.
