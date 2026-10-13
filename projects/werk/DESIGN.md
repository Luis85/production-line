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

Factory is the portfolio hierarchy entry; each line opens its independent
orchestrator with the live line map (`#system`) as the default page after
authentication. Explicit `#intake`, `#tasks`, `#workers` and `#metrics` links open
their requested area after connection. Factory has no taskboard. The main journey
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
1760px. Worker status remains a focused detail surface. Tables scroll when
necessary instead of compressing identity and evidence beyond readability.

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

The operational Factory view starts on a canvas map with orthographic 3D and
2D representations, a contextual inspector and native component-selection
buttons. Connections and table alternatives retain the same scoped response.
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
Worker status shows process health, current slots and local evidence without
offering a parallel task-management UI. Its slot display is bounded to the first
24 configured slots and labels occupancy as a local observation; an unoccupied
slot is not a promise that work can be scheduled.

Connection, loading, stale data and empty filters are distinct states. Tokens
stay in page memory and never enter URLs or browser storage. Runtime drafts
remain in page memory while navigating and reconnecting. Live updates can be
paused and preserve selection/filter context. User navigation moves focus appropriately; background updates do not.
Dialogs isolate the background and restore trigger focus. Reduced motion and
keyboard-equivalent actions remain requirements for the spatial view.

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
