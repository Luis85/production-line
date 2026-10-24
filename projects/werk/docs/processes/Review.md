---
order: 5
prev_step: "[[Post-Production]]"
next_step: "[[Merge]]"
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
  - "[[System User]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
owner: "[[Worker]]"
supplier:
  - "[[Git Repository]]"
  - "[[Worker Queue]]"
  - "[[System User]]"
customers:
  - "[[Worker]]"
  - "[[System User]]"
  - "[[projects/werk/docs/entities/systems/Orchestrator|Orchestrator]]"
  - "[[projects/werk/docs/entities/systems/Factory|Factory]]"
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
