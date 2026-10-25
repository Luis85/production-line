---
pbl-id: 51
type: PBI
parent: "[[Worker intake to published release]]"
order: 43999.999762
status: Done
tags:
  - primary-workflow
priority: P0
dependsOn:
  - "[[Pinned Claude execution and verification]]"
finished: 2026-10-25
---

# Owned PR feedback and guarded rework

Create the initial hosting-service PR after green independent verification, then retain the same owned PR through human feedback and subsequent verified candidates. Guard remote branch updates against their exact prior head, preserve immutable receipts and reconcile unknown acknowledgements.

Exit: actual bare Git tests cover initial creation, authorized update, unrelated/raced heads and unchanged developer index; host/journal fixtures cover stable PR identity, stale acceptance and restart without duplication.

See [candidate publication](../../how-to/publish-worker-candidates.md) and [Review](../../processes/Review.md).
