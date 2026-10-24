---
pbl-id: 1
type: PBI
order: 43250
status: Active
tags:
  - implementation-plan
  - planned
  - p0
priority: P0
started: 2026-10-12
parent: "[[The Worker]]"
---

# P0-01 Project binding and pinned requirement context

Partially implemented: the [pinned context resolver and operator binding](../../reference/pinned-context.md) now persist immutable manifests before task creation. Workers verify assigned context and record its digest, including retries and recovery. Full Obsidian artifacts, verified remote repository/iteration identity, and live provider consumption remain unfinished; this item stays Active. Explicit pinned iteration imports now validate the committed feature and scheduling metadata against the server binding. See the [pass 4 review](../../reports/pass4-review.md).

## Source

[[docs/handoff/implementation-plan]] · [[docs/handoff/technical-contracts]] · [[docs/handoff/acceptance]]

## Deliverable and likely source boundary

Project binding and pinned requirement context; orchestrator application/repository, `shared/wiki.ts`, new context adapter

## Source dependencies

Baseline

## Demonstrable exit

A committed fixture note resolves to an immutable context manifest; missing/ambiguous/out-of-root links fail before coding

## Readiness and completion

Apply the Definition of Ready and Definition of Done in the source implementation plan. Keep unfinished live paths disabled and mock the default. Live verification remains pending until the explicit live acceptance gate is satisfied.
