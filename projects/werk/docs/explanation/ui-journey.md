# UI journey and layout contract

## One workflow, two clearly identified surfaces

The Factory webview is the portfolio/hierarchy entry point. Selecting a line
opens its independent orchestrator, which starts on **Intake**. Factory has no
duplicate taskboard. Partial line availability remains visible in rollups. Its HTTP-backed taskboard and
portfolio display persisted server state and measurements from actual **mock**
worker execution. `/concept` is a separate interactive simulation of the target
architecture and delivery lifecycle; its browser state does not update SQLite.
Keep the distinction visible at entry points and in completion language.

The normal product-team workflow starts in its Obsidian repository: planning,
iteration branch/draft PR, ready feature properties, then the CLI importer.
A single requirement wikilink is sufficient for lightweight line intake; the
user does not copy its title and criteria into the form. Manual detailed intake
remains an explicit alternative. The webview
explains the import command; it cannot browse a local Git checkout or perform
real Git PR operations in this starter.

| Stage | User question | Interface and next action |
| --- | --- | --- |
| Connect | Am I viewing the intended factory? | Token entry and explicit connection/last-refresh state; token stays in page memory |
| Intake | Which ready work is being handed over? | Project plus one requirement wikilink; repository import guidance and optional manual details |
| Track | Has the factory accepted and assigned it? | After submission, Taskboard; choose the feature to inspect its persisted events |
| Inspect evidence | What happened during this attempt? | Selected task links to its scoped snapshot view; worker view gives project/profile/capacity context |
| Analyze | What can be compared reliably? | Portfolio filters, sample counts, latest-window disclosure and unknown cost/quality states |
| Review delivery | Is the feature accepted? | Target workflow requires human review and verified feature-PR merge; mock status never implies this |

The worker's local page is an operational detail view: process state, occupied
slots, current attempts, profile configuration, last contact, last error and
latest snapshot identity. It is read-only and does not introduce a second task
management interface. Docker status ports must be discovered from the actual
replica mapping; do not fabricate a local URL from a worker ID.

## State and feedback

Forms own unsent draft values; the server owns accepted work and its status.
Retain a stable submission identity when retrying an uncertain response. A
network failure must preserve enough context to retry and must not be presented
as a definite server rejection. A successful submission points to the accepted
task, rather than asking the user to infer success from an empty form.

After successful connection, the authentication form collapses; Disconnect
restores it and preserves the unsent intake draft. The task-to-snapshot action
clears conflicting filters and visibly scopes metrics to that task, with an
explicit action to return to all tasks.

Live refresh is pausable. Loading, last successful refresh, disconnected and
stale data states remain distinct. Changing tabs or reconnecting must not allow
an older asynchronous response to replace the newly selected state. Refreshing
data must preserve the user's selected filters and avoid taking keyboard focus.
Navigation and deliberate task-inspection actions can move focus to their
heading; background refresh cannot.

Tables use textual status labels, accessible headers and responsive scrolling.
Empty states explain whether there is no work, no matching filter result or no
successful response. Browser-visible errors describe the next useful action
without exposing credentials or raw infrastructure details.

## Shared spacing vocabulary

The concept, orchestrator and worker views use the same scale and semantic roles.
Values below are confirmed in their CSS; they are not merely proposed tokens.

| Token | Desktop value | Purpose |
| --- | --- | --- |
| `--space-1` | 4px | Tight alignment |
| `--space-2` | 8px | Inline spacing |
| `--space-3` | 12px | Compact control/row spacing |
| `--space-4` | 16px | Related fields |
| `--space-6` | 24px | Panel padding |
| `--space-8` | 32px | Page padding and section rhythm |
| `--space-12` | 48px | Major two-column separation |
| `--space-page` | `--space-8` | Outer page padding |
| `--space-panel` | `--space-6` | Panel content inset |
| `--space-section` | `--space-8` | Separation of distinct tasks/sections |
| `--space-field` | `--space-4` | Related form fields |
| `--space-inline` | `--space-2` | Inline actions and labels |

At widths up to 760px, page/panel padding is 16px and section spacing is 24px.
Use semantic roles when laying out a view and scale tokens for local adjustments.
Do not add an unrelated bottom margin and parent gap to the same relationship.
Keep one authoritative selector per viewport rather than stacking corrective
CSS overrides at the bottom of the stylesheet.

The operational views use 16px system text with 1.6 line height, a dark background
`#111b22`, foreground `#edf4f7`, muted text `#b5c4cd`, borders `#3b4b56` and mint
`#8be0b8` for primary actions. The concept keeps its spatial-project palette
(mint, blue and amber) and darker slate surfaces. Consistency means matching
roles and rhythm; project identity colors do not become health classifications.

Standard controls share a 44px minimum interaction height across runtime and
concept views; explicitly compact secondary controls retain scoped styles. Both need visible keyboard focus and readable status
text; color alone does not convey success, health, project or provider. Reduced
motion suppresses unnecessary movement, and data updates must not animate chart
points as though unrelated worker observations were a continuous path.

## Analytical honesty

The portfolio loads a bounded newest-first window, announces truncation and
uses the paginated API for full export. Chart sampling does not change the
statistical sample used by summary values. Snapshot pair completeness counts
observed phases inside the selected window; it cannot prove that all scheduled
attempts emitted data. Process resource gauges may overlap across parallel
attempts. A missing token, cost or quality measurement stays unknown/not run.

## Verification boundary

Source, state transitions, response ordering and rendering contracts have
functional/static coverage. No browser or screenshot session was available for
this pass. Visual rhythm, keyboard journeys, responsive tables, zoom and device
touch behavior still require rendered inspection before a production release.

## Factory navigation

Factory's tree, breadcrumbs and scope picker communicate the selected logical
factory. Its overview includes descendant lines. The empty-state sequence is
create factory → register line → open that line's Intake. Factory create/edit
forms manage hierarchy; line forms distinguish server-reachable orchestrator
URL from browser-facing Intake URL and a server-side credential reference.

Registry deletion confirmations explicitly state that running work is not
stopped. Failed creates retain their generated identity and draft. Failed
refreshes retain per-scope cached results with a stale label; unavailable line
counts stay Unknown and aggregate sums are marked reachable-only. Opening a
line does not transfer the Factory login token. Separate tabs use opener/referrer
isolation. The Factory token remains only in page memory.
