---
type: Process
actors:
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 7
inputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
outputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[Increment Updated]]"
  - "[[Process Updated]]"
supplier:
  - "[[Git Repository]]"
  - "[[System User]]"
customers:
  - "[[Worker]]"
  - "[[System User]]"
  - "[Factory](../entities/systems/Factory.md)"
  - "[Orchestrator](../entities/systems/Orchestrator.md)"
prev_step: "[[Merge]]"
next_step: "[[Publish]]"
status: Open
owner: "[[System]]"
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

# Build

After the explicit plain-Git main-checkout merge, the team uses its normal project build workflow and retains the resulting evidence. The default Markdown handoff does not claim that this later build happened and does not enable GitHub integration.

## Optional managed release build

When the project explicitly enables and approves the GitHub release extension, the worker builds the exact confirmed merged commit in an owned isolated workspace. It runs the pinned build executable/arguments within the approved timeout and retains source, operation identity and safe artifact paths, sizes and SHA-256 digests.

Missing or unsafe files, nonzero exit and timeout fail the managed build. Its failure preserves the earlier merge receipt and remains a release blocker. An interrupted unknown process is reconciled or explicitly inspected/stopped before another build. Feature text cannot replace the approved build definition.
