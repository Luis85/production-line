---
pbl-id: 9
type: PBI
order: 9000
status: Active
tags:
  - implementation-plan
  - planned
  - p0
priority: P0
dependsOn:
  - "[[P0-05 First real Claude or Codex adapter integrated end to end]]"
  - "[[P0-06 Head-bound quality gates and human review request]]"
  - "[[P0-07 Durable Git event ingestion, feedback attempts and verified merge]]"
  - "[[P0-08 Second native provider adapter, mixed profiles and shared quota
    policy]]"
started: 2026-10-12
---

# P0-09 Live telemetry and UI completion across line, worker and Factory

Planned future work imported from the supplied concept. No implementation is claimed.

## Source

[[docs/handoff/implementation-plan]] · [[docs/handoff/technical-contracts]] · [[docs/handoff/acceptance]]

## Deliverable and likely source boundary

Live telemetry and UI completion across line/worker/Factory

## Source dependencies

P0-05–08

## Demonstrable exit

Cost/quality provenance and unknown coverage remain visible; human journey matches persisted live state and partial line availability

## Readiness and completion

Apply the Definition of Ready and Definition of Done in the source implementation plan. Keep unfinished live paths disabled and mock the default. Live verification remains pending until the explicit live acceptance gate is satisfied.

## 2026-10-12 user-scope update

Factory hierarchy/capabilities, line-specific orchestrator, worker details, separate design guide, readiness and sanitized structured monitoring are now implemented and verified in mock mode. These changes do not satisfy the live provider/cost/quality acceptance gate. See the [current review](../../reports/journey-review.md).
