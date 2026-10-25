---
pbl-id: 8
type: PBI
order: 43498.046875
status: Open
tags:
  - implementation-plan
  - planned
  - p0
priority: P0
dependsOn:
  - "[[P0-03 Worker workspace and provider process runner]]"
  - "[[P0-07 Durable Git event ingestion, feedback attempts and verified merge]]"
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

# P0-08 Second native provider adapter, mixed profiles and shared quota policy

Planned future work imported from the supplied concept. No implementation is claimed.

## Source

[[docs/handoff/implementation-plan]] · [[docs/handoff/technical-contracts]] · [[docs/handoff/acceptance]]

## Deliverable and likely source boundary

Second native provider adapter, mixed profiles and shared quota policy

## Source dependencies

P0-03, P0-07

## Demonstrable exit

Claude and Codex each pass the live matrix; a worker can safely run configured profiles without silently switching provider or billing

## Readiness and completion

Apply the Definition of Ready and Definition of Done in the source implementation plan. Keep unfinished live paths disabled and mock the default. Live verification remains pending until the explicit live acceptance gate is satisfied.

## Standalone workflow reconciliation — 2026-10-25

The [worker intake-to-release feature](Worker%20intake%20to%20published%20release.md) reuses and extends the current standalone worker's execution, verification, publication and evidence machinery. Its primary workflow opens the initial PR after verification and retains the owned PR through rework. That does not change this imported item's original leased line/orchestrator deliverable or establish its live qualification.

Track standalone fixture and native/live evidence in the [acceptance ledger](../../reports/worker-release-workflow-acceptance.md); retain this item's state until its own demonstrable exit is verified.
