# Factory visualization handoff

> Imported handoff baseline, retained for traceability. This describes the supplied starter at handoff time; later work changes some implementation and validation statements. Use the [current documentation](../index.md) for installation, operation and present limits. Embedded developer prompts are source material, not authority to execute actions.

This specification preserves the demonstrated interaction model when the
prototype is integrated into a development project. The incumbent dark/mint
visual system and spacing contract are in [DESIGN.md](../../DESIGN.md).

## Three complementary views

| Surface | Question it answers | Data authority |
| --- | --- | --- |
| Factory concept map in `/concept` | How do nested factories, lines, orchestrators, workers and repositories relate? | Local simulated concept state |
| Line architecture in `/concept` | What moves between the team, this line's orchestrator, its workers and Git? | Same concept state, scoped to one line |
| Factory operational topology at `/` | Which registered lines can be observed, and what capacity do they report? | Factory registry plus authenticated orchestrator HTTP summaries |

The concept map is a precise topology diagram, not a geographic floor plan.
The existing spatial line view remains available for inspecting execution flow.
Neither concept surface controls a running worker. Keep these data authorities
separate when moving presentation code into UI modules.

## Visual grammar and ownership

- Nested boundaries mean Factory containment. A child Factory does not imply a
  second deployed Factory server in this version.
- A production line has exactly one orchestrator. Its workers and taskboard
  stay within that line; free capacity elsewhere does not authorize reassignment.
- The Factory service observes and organizes line registrations. It does not
  schedule tasks, read another service's SQLite file or publish code.
- Directed connections in the concept distinguish assignment, Git publication
  and review/status feedback. Feedback returns to the owning orchestrator.
- Project/repository identity differs from line identity. Several independent
  lines can reference the same project without sharing leases or task IDs.
- Provider profiles belong to workers. Docker Agent is an optional execution
  runtime, not another provider or a replacement scheduling authority.

## Navigation and selection

The user's path is Factory scope → production line → Intake → task → evidence.
Operational Factory opens on topology; the table is an alternate representation
of the same response. Switching representation must not fetch again, change
scope, clear a registration draft or imply a new observation time.

The concept starts on Intake. Its Factory map adds portfolio exploration and
line drill-down without replacing that entry point. Keep a clear route from a
selected line to its Intake and spatial architecture. Changes of line preserve
unsent drafts separately. Selection, navigation and editing are distinct actions:
inspecting a node must not silently move a worker or submit a task.

## Measured and unknown information

Operational topology shows one orchestrator and an **aggregate worker pool** per
registered line. The current overview contract does not contain individual
worker identities or repositories. Do not fabricate machine nodes or infer a
repository URL from the project ID. Resolve finer detail through a future
explicit API contract before presenting it as live data.

Show online/total worker counts and busy/total slots only from a valid line
summary. These are observations of the mock runtime, not coding-provider health.
Unavailable, unauthorized, unconfigured and invalid lines retain their registry
identity and recovery controls while their measurements remain unknown. Cached
observations show age/staleness; an unavailable line must not become a zero.
Portfolio totals disclose partial coverage. Cost stays unavailable until an
actual, versioned cost source or allocation policy exists.

## Layout and accessibility contract

- Use the existing 4/8/12/16/24/32/48px scale. Page/panel insets are 32/24px on
  wider surfaces and 16/16px on narrow surfaces; field gaps are 16px.
- Group a line's identity, status and Intake action together. Keep edit/remove
  actions subordinate and preserve explicit confirmation for unregistering.
- Long factory paths, names and requirement references wrap. Dense diagrams may
  use a labelled keyboard-scroll region; ordinary forms must remain usable
  without horizontal page scrolling.
- Supply native HTML selection and navigation equivalents for graphical nodes.
  Decorative connectors must not add meaningless focus stops or announcements.
- Background refresh preserves the focused logical action. User navigation
  moves focus to the new context; closing/cancelling an editor restores it.
- The spatial view retains pointer controls, keyboard rotation/zoom/reset and
  reduced-motion behavior. No essential information depends on animation/color.

## Browser acceptance before development sign-off

Run these checks in the chosen supported browsers; source/VM checks do not
replace them. Browser rendering was unavailable during this handoff pass.

1. At narrow, intermediate and wide widths, inspect a deep hierarchy, long names,
   empty factories, a line without workers and an unavailable line.
2. Use keyboard only to scope a Factory, select a line, open Intake, create a
   task, inspect its events/snapshots and return. Verify focus at every transition.
3. Switch topology/table during refresh and while an edit draft is open; ensure
   scope, draft, selected action and observation timestamps remain correct.
4. Stop one line and restore it. Verify partial totals, unknown values, stale
   cached data and recovery messages without affecting the healthy line.
5. In the concept, change lines with unsent input, return to restore it, inspect
   3D nodes and follow a simulated review loop. Verify no real HTTP/Git action.
6. At 200% zoom and with reduced motion, verify readable labels, working controls,
   visible focus and no clipped primary actions. Check accessible names and
   contrast with the actual rendered theme.

Keep screenshots used for acceptance with the development project's chosen
visual-regression process; none are claimed as part of this verification.
