# Visual system experience review

Date: 2026-10-13. Follow-up to merged PR2, based on main. This report describes
source changes and an unpublished local archive; it does not claim a new release.

## Result

The operational Factory and line views now lead with interactive orthographic
3D/2D maps. Selecting a component explains its responsibilities, observed state
and available next actions. Both representations use the same observations.
Factory retains the full registry and ownership editors; line navigation opens
focused Intake, taskboard, workers and evidence views with browser history.

Intake previews the chosen submission, tasks show status columns and event
timelines, worker detail maps profiles and reported active tasks, and snapshots
show readable facts before optional JSON. The worker status page visualizes local
slot occupancy. The public architecture guide uses explicitly illustrative data
and provides a local YAML composer for a new one-line mock system.

The renderer and guide are bundled with the runtime and extracted release; no
CDN, remote script or WebGL dependency is needed. Tokens stay in memory.

## Screenshot storyboard

Each pair shows the final desktop (1440px) and mobile (390px) browser capture.

| Step | Desktop | Mobile |
| --- | --- | --- |
| Understand Factory ownership and available lines | [Factory](../evidence/visual-system-factory-1440.png) | [Factory](../evidence/visual-system-factory-390.png) |
| Explore the selected line and choose a workspace | [Line map](../evidence/visual-system-line-1440.png) | [Line map](../evidence/visual-system-line-390.png) |
| Prepare and preview work | [Intake](../evidence/visual-system-intake-1440.png) | [Intake](../evidence/visual-system-intake-390.png) |
| Follow saved work by status | [Taskboard](../evidence/visual-system-tasks-1440.png) | [Taskboard](../evidence/visual-system-tasks-390.png) |
| Inspect a worker and its profiles | [Worker detail](../evidence/visual-system-worker-detail-1440.png) | [Worker detail](../evidence/visual-system-worker-detail-390.png) |
| Prepare a system definition locally | [Composer](../evidence/visual-system-composer-1440.png) | [Composer](../evidence/visual-system-composer-390.png) |

## Review and fixes

Two author screenshot passes and one dedicated finish review examined the runtime
and guide. The reviewer requested five corrections: touch/keyboard panning,
visible active mobile navigation, focus return to visible cards, protection from a
delayed worker-task lookup, and earlier Factory map placement on mobile. All five
were fixed and recaptured; the reviewer's final disposition was **ship**, with no
remaining required fixes from that review. The reviewer used supplied screenshots,
source and browser reports; browser execution was performed by the implementation
agent. This is a focused UI review, not a new all-product security certification.

## Verification

- `npm run check`: 490 tests, 489 passed, zero failures, one existing PowerShell
  restart-guidance test skipped on Linux.
- `npm run audit:dependencies`: zero reported vulnerabilities.
- Final browser captures: 12 surfaces at both 1440px and 390px, zero page-script
  errors and no whole-page horizontal overflow. Twelve representative PNGs are
  retained above; the other local captures covered 2D mode, workers, metrics,
  snapshot detail, guide and worker status.
- Browser interactions: actual touch and keyboard panning in both representations,
  active mobile tab visibility and Back/Forward, detail focus restoration, poll
  focus preservation, stale/recovery and disconnect handling, explicit hash entry,
  viewer capability fixture, and the delayed-response race.
- Composer: rejected invalid identifiers and port ranges; the actual downloaded
  YAML passed `system plan`. The guide also passed a 320px overflow check.
- Extracted local archive: native system startup, simulated task completion, two
  snapshots, shutdown/restart with state preserved. No real provider invocation.
- Portable `tests/ui/browser/visual-navigation.mjs` rerun passed all seven checks
  with zero page errors. See [test instructions](../../tests/README.md).

Sanitized [validation evidence](../evidence/visual-system-validation.json) records
viewport observations, interaction checks and qualification limits. Forge guarded
writes and repository checks are used for the source changes. Impeccable's context
launcher and detector were absent, so existing design records and rendered browser
evidence provided the documented fallback.

## Boundaries

Factory maps at most 12 lines and 20 factories in the selected scope, and labels
that bound; full tables remain available. Worker pools are aggregates from the
summary API. Taskboard columns contain the current filtered page, not all work.
Worker configuration is read-only. The composer prepares a new definition and
never applies changes to a running system or migrates its state. Native startup's
default two-line system is unchanged. Mock completion means simulated execution,
not implemented or accepted features. Docker and Windows were not rerun locally
for this UI pass; CI and their prior qualification remain separate evidence.
