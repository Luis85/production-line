---
pbl-id: 53
type: PBI
parent: "[[Worker intake to published release]]"
order: 43999.999941
status: Done
tags:
  - primary-workflow
priority: P0
dependsOn:
  - "[[Verified merge of current reviewed candidate]]"
finished: 2026-10-25
---

# Exact-source build and GitHub Release publication

Build the confirmed merged commit using the pinned project build definition. Retain source, process result and safe artifact inventory/digests. Publish to the configured GitHub repository/tag and confirm release visibility and expected assets before completion.

Exit: real process/filesystem and host fixtures cover build failure, missing/unsafe/changed artifacts, partial/draft uploads, differing tags/assets and lost acknowledgement without destructive overwrite or duplicate releases. Failed later stages preserve prior successful milestones.

See [Build](../../processes/Build.md), [Publish](../../processes/Publish.md) and the [workflow contract](../../reference/worker-release-workflow.md).
