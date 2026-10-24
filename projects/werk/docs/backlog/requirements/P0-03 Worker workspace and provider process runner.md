---
pbl-id: 3
type: PBI
order: 43437.5
status: Open
tags:
  - implementation-plan
  - planned
  - p0
priority: P0
dependsOn:
  - "[[P0-02 Versioned live execution and evidence contracts]]"
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

# P0-03 Worker workspace and provider process runner

Planned future work imported from the supplied concept. No implementation is claimed.

## Source

[[docs/handoff/implementation-plan]] · [[docs/handoff/technical-contracts]] · [[docs/handoff/acceptance]]

## Deliverable and likely source boundary

Worker workspace and provider process runner; `worker/application` ports, infrastructure, configuration

## Source dependencies

P0-02

## Demonstrable exit

One slot runs a controlled fixture CLI in its own worktree with cancellation, bounded output, auth separation and truthful results

## Readiness and completion

Apply the Definition of Ready and Definition of Done in the source implementation plan. Keep unfinished live paths disabled and mock the default. Live verification remains pending until the explicit live acceptance gate is satisfied.
