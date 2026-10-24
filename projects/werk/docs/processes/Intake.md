---
order: 1
next_step: "[[Pre-Production]]"
prev_step:
emits:
  - "[[New Feature Request]]"
  - "[[Process Updated]]"
inputs:
  - "[[Feature Request]]"
outputs: "[[Feature Request]]"
actors:
  - "[[System User]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Intake Form]]"
  - "[[Command Line]]"
rules:
  - "[[Feature Request Validation]]"
owner: "[[System]]"
supplier: "[[System User]]"
customers:
  - "[[Worker]]"
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
