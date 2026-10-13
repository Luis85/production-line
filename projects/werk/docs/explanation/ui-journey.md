# UI journey and layout contract

## One workflow, two clearly identified surfaces

The Factory webview is the portfolio/hierarchy entry point. Selecting a line
opens its independent orchestrator, which starts on the **line map** (`#system`)
after authentication. Explicit `#intake`, `#tasks`, `#workers` and `#metrics`
links retain their requested destination after connection. Factory has no
duplicate taskboard. Partial line availability remains visible in rollups. The
Factory map and line map display HTTP-backed observations; the line's taskboard
displays its persisted task state. Default **mock**
attempts end as `simulated`; explicitly configured Codex CLI attempts can produce a
local change set in `review`, which still requires human validation. `/concept` is a separate interactive simulation of the target
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
| Orient | How does this line work, and what needs attention? | Live 3D/2D map with observed queue, capacity, results and snapshot facts; inspector actions open the relevant workspace |
| Intake | Which ready work is being handed over? | Project plus one requirement wikilink; repository import guidance and optional manual details |
| Track | Has the factory accepted and assigned it? | After submission, Taskboard; choose the feature to inspect its persisted events |
| Inspect evidence | What happened during this attempt? | Selected task links to its scoped snapshot view; worker view gives project/profile/capacity context |
| Analyze | What can be compared reliably? | Portfolio filters, sample counts, latest-window disclosure and unknown cost/quality states |
| Review delivery | Is the feature accepted? | Target workflow requires human review and verified feature-PR merge; mock status never implies this |

The worker's local page is an operational detail view: process state, occupied
slots, current attempts, profile configuration, last contact, last error and
latest snapshot identity. The visual slot display is bounded to the first 24
configured slots; local occupancy does not establish scheduling eligibility.
It is read-only and does not introduce a second task management interface. Docker status ports must be discovered from the actual
replica mapping; do not fabricate a local URL from a worker ID.

## State and feedback

Forms own unsent draft values; the server owns accepted work and its status.
Retain a stable submission identity when retrying an uncertain response. A
network failure must preserve enough context to retry and must not be presented
as a definite server rejection. A successful submission points to the accepted
task, rather than asking the user to infer success from an empty form.

After successful connection, the authentication form collapses; Disconnect
restores it and preserves the unsent intake draft. Runtime drafts remain in
memory while navigating; tokens never enter URLs or browser storage. Hash routes
and browser Back/Forward restore the selected workspace after authentication;
the active navigation item remains visible within the mobile navigation strip.
The task-to-snapshot action clears conflicting filters and visibly scopes metrics to that task, with an
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

## Spatial views and focused detail

The shared canvas presents orthographic 3D and 2D versions of the same model.
Pointer dragging rotates 3D; named camera controls rotate, zoom and reset. Touch
gestures and native arrow-key scrolling pan the diagram in either mode; Home
resets the camera. Native component buttons expose selection without depending
on canvas hit targets. A contextual HTML inspector presents full labels, facts
and actions. Deliberate selection focuses its heading; refresh preserves context.
The inspector moves below the map at 1100px and becomes one column at 760px.

The taskboard groups only the currently loaded, filtered page into status
columns. Worker cards show the loaded worker page. Their table alternatives
remain available. Task detail has a readable event timeline, worker detail maps
reported profiles and active tasks, and snapshot detail exposes key facts before
the full JSON. The worker-detail endpoint's bounded active-task response is
labeled when truncated. Closing task or worker detail returns focus to its
visible card when available.

Intake puts Vault-reference and manual-feature choices beside the fields and a
preview of the planned work. Readiness, access, import explanations and raw data
use progressive disclosure. These visual adapters keep accepted work and task
state under the orchestrator's authority.

The public `/guide` map is illustrative and calls no live APIs. Its local YAML
composer prepares one Factory and one line with one to eight mock workers for
native or Docker startup. Download, launcher validation and starting in a new
state directory are explicit separate steps. It neither changes a deployment
nor migrates existing state, and it does not change the native launcher's
default two-line system.

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
functional/static coverage. Dated [review reports](../reports/index.md) record
which rendered browser journeys and viewport checks were exercised in each pass.
A historical pass without a browser session is not the current product contract;
likewise, a screenshot alone does not establish keyboard, zoom or touch behavior.
Use the evidence for the release candidate being assessed.

## Factory navigation

Factory's tree, breadcrumbs and scope picker communicate the selected logical
factory. Its overview includes descendant lines. The empty-state sequence is
create factory → register line → open that line's map or Intake. Factory create/edit
forms manage hierarchy; line forms distinguish server-reachable orchestrator
URL from the browser-facing line webview URL and a server-side credential reference.

The Factory map shows the first 12 lines and 20 factories in the selected scope;
its legend discloses that bound. Scope selection and the complete registry/table
remain available. Each line shows its registered orchestrator and an aggregate
worker pool; Factory does not infer individual worker identities from summary
counts. Map, connection and table representations share observations and
timestamps. The editor previews the selected ownership route and preserves the
existing distinction between browser-managed and YAML-managed registrations.

Registry deletion confirmations explicitly state that running work is not
stopped. Failed creates retain their generated identity and draft. Failed
refreshes retain per-scope cached results with a stale label; unavailable line
counts stay Unknown and aggregate sums are marked reachable-only. Opening a
line does not transfer the Factory login token. Separate tabs use opener/referrer
isolation. The Factory token remains only in page memory.
