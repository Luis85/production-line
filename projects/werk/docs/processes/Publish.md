---
type: Process
actors:
  - "[[System User]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 8
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
  - "[[System User]]"
  - "[[Git Repository]]"
customers:
  - "[[Worker]]"
  - "[[System User]]"
  - "[[projects/werk/docs/entities/systems/Factory|Factory]]"
  - "[[projects/werk/docs/entities/systems/Orchestrator|Orchestrator]]"
prev_step: "[[Build]]"
status: Open
owner: "[[System]]"
parent: "[[Direct Feature Request to a Worker through the Webview]]"
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
