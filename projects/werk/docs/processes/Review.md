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
  - "[[projects/werk/docs/entities/systems/Orchestrator|Orchestrator]]"
  - "[[projects/werk/docs/entities/systems/Factory|Factory]]"
prev_step: "[[Post-Production]]"
next_step: "[[Merge]]"
status: Open
owner: "[[Worker]]"
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
