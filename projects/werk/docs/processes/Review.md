---
type: Process
actors:
  - "[[System User]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 5
inputs:
  - "[[Feature Request]]"
  - "[[Pull Request]]"
  - "[[Increment]]"
outputs:
  - "[[Feature Request]]"
  - "[[Pull Request]]"
  - "[[Increment]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[Pull Request Updated]]"
  - "[[Increment Updated]]"
  - "[[Process Updated]]"
supplier:
  - "[[Git Repository]]"
  - "[[Worker Queue]]"
  - "[[System User]]"
customers:
  - "[[Worker]]"
  - "[[System User]]"
  - "[Orchestrator](../entities/systems/Orchestrator.md)"
  - "[Factory](../entities/systems/Factory.md)"
prev_step: "[[Post-Production]]"
next_step: "[[Merge]]"
status: Open
owner: "[[Worker]]"
parent: "[[Direct Feature Request to a Worker through the Webview Worker Intake]]"
started: ""
finished: ""
horizon: ""
start: ""
due: ""
risk: ""
priority: ""
assignee: ""
iteration: ""
---

# Review

The worker presents the accepted outcome, current candidate diff, automated/manual criteria, quality reports, limitations and PullRequest Markdown handoff. A person records acceptance or requests changes against the exact current request revision, delivery run and candidate identity.

The default handoff identifies source/review Git branches. After review and required current-candidate human outcomes, the user explicitly allows the worker to merge into the displayed assigned main checkout. It requires no hosting-service PR or GitHub CLI. Requested changes retain the same Feature Request and produce fresh verification/handoff evidence; changed scope needs an explicit revised or successor request. Candidate acceptance alone does not grant that checkout mutation or claim a merge, build or release.

## Optional GitHub review

An explicitly committed and locally approved GitHub integration can add a hosting-service PR. Verified rework updates that same owned open PR under an expected-head guard. Managed merge is available only when required checks and human decisions match its current published head and the approved policy permits the action. A closed/unmerged PR or stale decision remains actionable.
