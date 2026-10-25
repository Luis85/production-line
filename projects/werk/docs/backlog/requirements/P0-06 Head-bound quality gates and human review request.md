---
pbl-id: 6
type: PBI
order: 43492.1875
status: Open
tags:
  - implementation-plan
  - planned
  - p0
priority: P0
dependsOn:
  - "[[P0-05 First real Claude or Codex adapter integrated end to end]]"
parent: "[[The Worker]]"
started: ""
finished: ""
horizon: ""
start: ""
due: ""
risk: ""
assignee: ""
iteration: ""
---

# P0-06 Head-bound quality gates and human review request

Planned future work imported from the supplied concept. No implementation is claimed.

## Source

[[docs/handoff/implementation-plan]] · [[docs/handoff/technical-contracts]] · [[docs/handoff/acceptance]]

## Deliverable and likely source boundary

Head-bound quality gates and human review request

## Source dependencies

P0-05

## Demonstrable exit

Only passing checks on the current published head can mark ready/request review; changes invalidate previous approvals/checks

## Readiness and completion

Apply the Definition of Ready and Definition of Done in the source implementation plan. Keep unfinished live paths disabled and mock the default. Live verification remains pending until the explicit live acceptance gate is satisfied.

## Standalone workflow reconciliation — 2026-10-25

The [worker intake-to-release feature](Worker%20intake%20to%20published%20release.md) reuses and extends the current standalone worker's execution, verification, publication and evidence machinery. Its primary workflow opens the initial PR after verification and retains the owned PR through rework. That does not change this imported item's original leased line/orchestrator deliverable or establish its live qualification.

Track standalone fixture and native/live evidence in the [acceptance ledger](../../reports/worker-release-workflow-acceptance.md); retain this item's state until its own demonstrable exit is verified.
