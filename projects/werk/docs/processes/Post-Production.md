---
type: Process
actors:
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 4
inputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
outputs:
  - "[[Feature Request]]"
  - "[[Pull Request]]"
  - "[[Increment]]"
emits:
  - "[[New Pull Request]]"
  - "[[Increment Updated]]"
  - "[[Process Updated]]"
supplier:
  - "[[Git Repository]]"
  - "[[Worker Queue]]"
  - "[[Increment Verification Pipeline]]"
customers:
  - "[[Worker]]"
prev_step: "[[Production]]"
next_step: "[[Review]]"
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

The worker executes the [[Increment Verification Pipeline]].
The worker updates the [[Increment]]. 

Once the verification pipeline is green, the worker creates a new pull-request.

If the pipeline fails, the increment gets send back to the production step for rework.