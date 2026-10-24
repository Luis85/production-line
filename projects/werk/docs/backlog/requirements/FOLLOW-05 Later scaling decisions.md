---
pbl-id: 14
type: PBI
order: 44375
status: Active
tags:
  - implementation-plan
  - planned
  - follow-on
started: 2026-10-12
parent: "[[Cross-Cutting Concerns]]"
---

# Later scaling decisions

Planned future work; not implemented by this setup.

Source: [[docs/handoff/implementation-plan#Follow-on work after the live slice]]

add rollups/background analytics before replacing SQLite. Do not introduce PostgreSQL, a message broker, server replicas or Factory federation without a measured requirement and a new architecture decision.

The source does not specify a dependency graph for this follow-on item. Optional/later items are retained for discovery, without implying authorization or readiness for implementation.

## 2026-10-12 user-scope update

The user now explicitly requests IaaS and Twelve-Factor practices. The native Ubuntu cloud-init profile, artifact verification, configuration/logging and shutdown work are implemented. SQLite/worker journals still require durable single-writer state. External transactional persistence and durable evidence/replay design are the remaining architectural work before stateless replicas or HA; a separate broker is not inherently required. See the [audit](../../reports/twelve-factor-audit.md). The imported note above records the original scope; it does not override the current user request.
