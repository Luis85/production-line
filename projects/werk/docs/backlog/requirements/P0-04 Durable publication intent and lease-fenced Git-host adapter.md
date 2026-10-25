---
pbl-id: 4
type: PBI
order: 43468.75
status: Open
tags:
  - implementation-plan
  - planned
  - p0
priority: P0
dependsOn:
  - "[[P0-02 Versioned live execution and evidence contracts]]"
  - "[[P0-03 Worker workspace and provider process runner]]"
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

# P0-04 Durable publication intent and lease-fenced Git-host adapter

Planned future work imported from the supplied concept. No implementation is claimed.

## Source

[[docs/handoff/implementation-plan]] · [[docs/handoff/technical-contracts]] · [[docs/handoff/acceptance]]

## Deliverable and likely source boundary

Durable publication intent and lease-fenced Git-host adapter in the line boundary

## Source dependencies

P0-02, P0-03

## Demonstrable exit

Before snapshot is committed/pushed and one stable draft PR opens before implementation; interrupted retries reconcile without duplicate PRs

## Readiness and completion

Apply the Definition of Ready and Definition of Done in the source implementation plan. Keep unfinished live paths disabled and mock the default. Live verification remains pending until the explicit live acceptance gate is satisfied.

## Standalone workflow reconciliation — 2026-10-25

The [worker intake-to-release feature](Worker%20intake%20to%20published%20release.md) reuses and extends the current standalone worker's execution, verification, publication and evidence machinery. Its primary workflow opens the initial PR after verification and retains the owned PR through rework. That does not change this imported item's original leased line/orchestrator deliverable or establish its live qualification.

Track standalone fixture and native/live evidence in the [acceptance ledger](../../reports/worker-release-workflow-acceptance.md); retain this item's state until its own demonstrable exit is verified.
