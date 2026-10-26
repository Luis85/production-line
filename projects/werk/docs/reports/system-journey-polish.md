# System journey polish — 2026-10-14

This pass follows the [worker iteration review](worker-iteration-review.md),
[deeper worker review](worker-deeper-review.md) and
[54-view worker atlas](worker-view-atlas.html). The atlas is a historical snapshot
from before this pass; the evidence below records the subsequent changes.

## Scope and acceptance

Five independent review/implementation agents covered the worker, Factory,
orchestrator, shared interaction/tours, and cross-system ownership/recovery. Each
implementation owner captured a baseline, made a bounded set of changes, then
confirmed the affected journeys in Chromium. The independent reviewer inspected
the combined diff and fed concrete race and draft-loss findings back to owners.
The existing slate/mint identity and each surface's language were preserved.

| Journey | Acceptance |
| --- | --- |
| Worker unlock → new task → compose → queue → history/review → Dashboard | Drafts survive recoverable failures; task identity and the single execution slot stay clear; evidence remains readable at 320px |
| Factory connect → aggregate → line Dashboard → intake → delivery | Mobile next actions remain visible; accepted work has a clear owner and a direct handoff; expiry does not erase unsent intake |
| Orchestrator connect → Intake → simulated task → events → snapshots | Requested destination survives authentication; task results are visible on mobile; late responses cannot replace newer navigation |
| Worker interaction dialog → connect → prepare/send → failure → reconnect/close | Polling cannot swallow Send; drafts remain scoped to their session; pending actions and recovery are visible |
| Routing, settings and tours | Pending saves do not accept conflicting edits; background reads preserve unsaved input; tour navigation waits for its target and restores focus |

## Improvements

### Worker

- Running-task copy receives the available width on narrow screens; its action
  moves beneath the title instead of compressing the title to a few characters.
- Filtered file-task review renders the matching status column; Escape closes
  the evidence view. Patch evidence remains review-only.
- New-task creation freezes its fields and close action while saving.
- Definition preview/import ignores duplicate pending actions and preserves
  newer YAML/name edits made while a request is pending.
- Existing worker work in this branch also separates file-task instructions from
  Chat, improves History search/filter/restore and Dashboard next actions,
  protects settings edits during refresh, lazily loads pages, and hardens
  session persistence, task admission and stale-read handling. Its detailed
  evidence remains in the two preceding review reports.

### Factory

- Mobile line dashboards keep the Factory-Intake action visible. Aggregate and
  line counters precede the spatial diagram, following the document order.
- Reference intake resets manual-field validation after success. Pending
  submission controls, feedback and duplicate guards make acceptance explicit.
- Authentication expiry preserves intake drafts; explicit disconnect clears
  them. Registry updates keep destination choices current.
- Delivery cards distinguish waiting, delivery and confirmed receipt, and link
  to the exact task owned by the destination orchestrator. Confirmed receipt
  does not mean execution or human acceptance.
- Assignment refresh updates the focused row after a successful mutation.
  Routing edits are protected from unrelated registry refreshes.
- The Factory experience source is formatted into readable control flow.

### Orchestrator

- Mobile taskboards stack populated status columns; an explicit control reveals
  empty statuses. Existing tasks no longer sit beyond empty horizontal columns.
- First-task help is shorter; accepted intake resets its preview. Snapshot and
  tour labels follow the surface's existing German language.
- Routing freezes inputs while loading/saving and fences stale errors by
  session/task. Reloading events preserves the task's unsaved destination input.
- `#tasks?task=<id>` opens the exact owning task after authentication. A monotonic
  route revision prevents an older link request from replacing a newer one.

### Shared interaction and tours

- Conversation polling and mutations have separate pending state, so a Send
  during a poll is accepted. Stale poll responses cannot overwrite the mutation.
- Connecting focuses the composer. New task retains the previous session's
  unsent draft while the dialog stays open; reconnect can restore it. Closing
  the dialog clears local drafts and credentials and restores trigger focus.
- Routed submission resets validation correctly, freezes pending controls and
  reports feedback beside its form. Message feedback sits beside the composer.
- Tours await asynchronous navigation, ignore stale callbacks, clear previous
  highlights, and keep their controls within the mobile viewport.

## Evidence and verification

- `npm run typecheck`: passed.
- `npm test`: 636 passed, one skipped, zero failures (637 discovered); rebuilds Factory, orchestrator and worker.
- Worker protocol smoke: 12 captures; invalid access, provider-status fixture,
  definition adaptation, paused queue, same-session follow-up, escaped HTML,
  clipboard, restart recovery and explicit Lock all passed.
- Worker layout/keyboard confirmation at 1440/390/320: no horizontal overflow;
  running-title width improved from 119px to 318px at 390, and from 49px to
  248px at 320. Escape closes evidence and restores the review-action focus.
- Factory browser journeys at 1440/390: visible intake entry, counters before
  maps, reference/manual validation, expiry recovery, routing draft retention,
  registry open/cancel and delivery links passed without page errors/overflow.
  At 1440, following the delivery link required separate orchestrator
  authentication, transferred no Factory token, and opened the exact remote task.
- Orchestrator: 18 final captures across nine states at 1440/390; no page errors
  or overflow. The real mock task persisted five events and paired snapshots.
- Shared UI fixture: send during polling, failed-draft retention, validation
  reset, connect/close focus and asynchronous tour target checks passed.
- `vault check --strict`: passed with no errors or warnings.

| Evidence | Saved captures and assertions |
| --- | --- |
| Worker | [Results](../evidence/archive/worker-journey-results.json), [before](../evidence/archive/worker-journey-before-running-mobile.png), [mobile](../evidence/archive/worker-journey-running-mobile.png), [320px](../evidence/archive/worker-journey-running-320.png), [composer](../evidence/archive/worker-journey-composer-mobile.png), [review](../evidence/archive/worker-journey-review-mobile.png) |
| Factory | [Results](../evidence/archive/2026-10-14-system-polish/factory/results.json), [before](../evidence/archive/2026-10-14-system-polish/factory/before-390-line.png), [after](../evidence/archive/2026-10-14-system-polish/factory/after-390-line.png), [delivery](../evidence/archive/2026-10-14-system-polish/factory/after-390-delivery.png) |
| Orchestrator | [Results](../evidence/archive/2026-10-14-orchestrator-journey-polish/results.json), [before](../evidence/archive/2026-10-14-orchestrator-journey-polish/before-task-detail-mobile.png), [after](../evidence/archive/2026-10-14-orchestrator-journey-polish/after-task-detail-mobile.png), [snapshot](../evidence/archive/2026-10-14-orchestrator-journey-polish/after-snapshot-detail-mobile.png) |
| Shared dialog/tours | [Results](../evidence/archive/journey-shared-results.json), [before](../evidence/archive/journey-shared-before-chat.png), [after](../evidence/archive/journey-shared-after-chat.png), [mobile tour](../evidence/archive/journey-shared-after-tour-mobile.png) |

No paid model call was made. Factory/orchestrator task execution used the actual
local mock services; worker provider execution used an explicit CLI protocol
fixture. Some worker/shared UI states were supplied by explicit browser fixtures.
These checks do not establish real provider authorization, model quality,
live Docker behavior or exhaustive assistive-technology support.
They do exercise the rendered workflows, response ordering, focus behavior and
mobile layouts described above.

Active architecture, entity ownership, operations and UI-journey documentation
were reconciled with the current three-surface product. Historical reports and
the preceding atlas retain their original scope.
