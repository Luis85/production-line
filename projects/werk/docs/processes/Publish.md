---
order: 8
prev_step: "[[Build]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[Increment Updated]]"
  - "[[Process Updated]]"
inputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
outputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
actors:
  - "[[System User]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
owner: "[[System]]"
supplier:
  - "[[System User]]"
  - "[[Git Repository]]"
customers:
  - "[[Worker]]"
  - "[[System User]]"
  - "[[projects/werk/docs/entities/systems/Factory|Factory]]"
  - "[[projects/werk/docs/entities/systems/Orchestrator|Orchestrator]]"
type: Process
parent: "[[Direct Feature Request to a Worker through the Webview]]"
status: Open
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
