---
order: 6
prev_step: "[[Review]]"
next_step: "[[Build]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[Pull Request Updated]]"
  - "[[Increment Updated]]"
  - "[[Process Updated]]"
inputs:
  - "[[Feature Request]]"
  - "[[Pull Request]]"
  - "[[Increment]]"
outputs:
  - "[[Feature Request]]"
  - "[[Pull Request]]"
  - "[[Increment]]"
actors:
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
owner: "[[System]]"
supplier:
  - "[[Git Repository]]"
  - "[[System User]]"
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
