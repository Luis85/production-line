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

The worker presents the request's accepted outcome, current candidate diff, automated and manual criteria, quality reports, limitations and GitHub PR identity. A person can record acceptance or request changes against the exact current request revision, delivery run, candidate commit and digest.

Requested changes return the same request to implementation/reverification and update its owned PR. Changed scope outside the accepted contract needs an explicit revised or successor request. Acceptance does not itself merge, build or publish.

## Exit and recovery

Merge is available only when required checks and human decisions still match the published head and the approved project policy permits the action. An approval for another head is stale. A closed/unmerged PR or missing manual criterion remains actionable rather than successful.
