---
pbl-id: 52
type: PBI
parent: "[[Worker intake to published release]]"
order: 43999.999881
status: Open
tags:
  - primary-workflow
priority: P0
dependsOn:
  - "[[Owned PR feedback and guarded rework]]"
---

# Verified merge of current reviewed candidate

Merge only the exact current accepted/published candidate under approved project policy and repository host rules. Record the hosting service's actual merge commit, including squash/rebase results; closed-without-merge is not success.

Exit: fixtures cover stale head/acceptance, conflict, closed PR, squash identity, lost acknowledgement and durable read-only reconciliation. An actual live reviewed merge is separately recorded in the acceptance ledger.

See [Merge](../../processes/Merge.md) and [workflow identities](../../reference/worker-release-workflow.md#identities-and-authority).
