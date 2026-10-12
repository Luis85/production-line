# Werk design record

## Product entry and capability boundary

Factory is the portfolio hierarchy entry; each line opens its independent
orchestrator with Intake as the first active page. Factory has no taskboard. The main journey is connect → hand over ready
features → follow task execution → inspect evidence. Product teams normally
plan in Obsidian, create an iteration branch/draft PR and import ready features.
Lightweight intake accepts one requirement wikilink in the selected project.
Title and criteria remain in the source note; unresolved references are labeled
honestly in mock execution. Detailed manual intake remains an alternative.

The orchestrator's operational webview reads persisted SQLite task state through
HTTP. The 3D concept simulates the target PR lifecycle using separate browser
state. Both explicitly distinguish mock completion from feature implementation,
human acceptance and merge. Do not route a concept action into the live API or
show simulated metrics as measured provider performance.

## Visual system

Spacing scale: 4, 8, 12, 16, 24, 32, 48px. The Factory, orchestrator, worker and concept views use `--space-*`
variables, with page=32, panel=24, section=32, field=16 and inline=8px roles.
At <=760px, page/panel=16 and section=24px. Selectors are consolidated by
component and viewport; avoid a stack of corrective overrides.

Operational surfaces: background #111b22, text #edf4f7, secondary #b5c4cd,
borders #3b4b56, action mint #8be0b8; system sans-serif 16px/1.6. Runtime controls
have a 44px minimum height. The orchestrator content max-width is 1180px; worker
status is a focused detail surface. Tables scroll when necessary instead of
compressing identity and evidence beyond readability.

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

The operational Factory view starts on topology, with a table alternative over
the same scoped response. It shows one orchestrator and an aggregate worker pool
per line, grouped by the owning Factory path. Do not invent individual workers
or repositories from the current summary API. Unknown/stale/partial observations
remain explicit; changing representation never changes the data timestamp.

The topology uses native controls, descriptive grouping and keyboard alternatives
for diagram selection. Long labels wrap in detail views; the precise concept map
scrolls when necessary. See `docs/handoff/visualization-spec.md` for the complete
UI handoff and browser acceptance checks.

## Interactions

A single vault requirement link leads runtime Intake; optional manual fields
and iteration-import guidance are progressively disclosed. A saved task has a
direct route to its detail, events and scoped snapshots. Opening that task clears
filters that could hide it. The concept also supports weekly ready-import and
keeps unsent feature drafts scoped to the selected production line. Factory
management shows portfolio context; line operations show the selected line.
Worker status shows process health,
current slots and local evidence without offering a parallel task-management UI.

Connection, loading, stale data and empty filters are distinct states. Tokens
stay in page memory. Live updates can be paused and preserve selection/filter
context. User navigation moves focus appropriately; background updates do not.
Dialogs isolate the background and restore trigger focus. Reduced motion and
keyboard-equivalent actions remain requirements for the spatial view.

The concept canvas uses pointer rotation, zoom, pan and equivalent buttons.
Its state model separates transitions, UI adaptation and spatial rendering;
it retains demo state locally and reports storage failures. Runtime webviews
use HTTP server authority and never depend on the concept localStorage state.

## Evidence and review

Dashboard summaries disclose sample count, selected scope and bounded history.
Unknown cost/quality stays unknown. Process CPU/RSS may overlap for concurrent
attempts. Snapshot pair completeness is observed evidence, not fleet-wide proof.
A mock execution cannot satisfy the target human-review/merge definition of done.

Implementation was inspected in source and through functional/static tests.
No browser screenshot, Docker or Windows execution was available. Responsive
spacing, keyboard focus, touch gestures and actual rendered contrast/layout
still need device/browser verification before release.

Detailed user journey and token rules: `docs/ui-journey.md` in the starter.
