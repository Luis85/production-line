---
pbl-id: 54
type: PBI
parent: "[[Worker intake to published release]]"
order: 43999.999971
status: Open
tags:
  - primary-workflow
priority: P0
dependsOn:
  - "[[Exact-source build and GitHub Release publication]]"
---

# Windows Claude and GitHub live qualification

Qualify the packaged native Windows runtime with an authenticated Claude Code CLI account and real GitHub repository/release destination. Exercise a failing check and repair, human feedback updating the same PR, exact-current acceptance/merge, source-bound build, asset publication and restart reconciliation.

Exit: sanitized retained evidence records actual runtime/OS/provider/request/PR/source/build/release identities and expected asset digests. Linux fixtures, API mocks and green source checks do not complete this PBI.

Follow the [acceptance scenario](../../reports/worker-release-workflow-acceptance.md#optional-github-end-to-end-acceptance-scenario). This item remains Open until that evidence exists.
