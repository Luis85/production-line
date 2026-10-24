---
pbl-id: 2
type: PBI
order: 43375
status: Open
tags:
  - implementation-plan
  - planned
  - p0
priority: P0
dependsOn:
  - "[[P0-01 Project binding and pinned requirement context]]"
parent: "[[The Worker]]"
---

# P0-02 Versioned live execution and evidence contracts

Planned future work imported from the supplied concept. No implementation is claimed.

## Source

[[docs/handoff/implementation-plan]] · [[docs/handoff/technical-contracts]] · [[docs/handoff/acceptance]]

## Deliverable and likely source boundary

Versioned live execution and evidence contracts; `shared/domain.ts`, `snapshots.ts`, validators, `orchestrator/schema.ts`

## Source dependencies

P0-01

## Demonstrable exit

Migration preserves old mock tasks/evidence; new live states are explicit, validated and backward-compatible where promised

## Readiness and completion

Apply the Definition of Ready and Definition of Done in the source implementation plan. Keep unfinished live paths disabled and mock the default. Live verification remains pending until the explicit live acceptance gate is satisfied.
