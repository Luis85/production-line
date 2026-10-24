---
type: Process
actors:
  - "[[System User]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Intake Form]]"
  - "[[Command Line]]"
order: 1
inputs:
  - "[[Feature Request]]"
outputs: "[[Feature Request]]"
emits:
  - "[[New Feature Request]]"
  - "[[Process Updated]]"
supplier: "[[System User]]"
customers:
  - "[[Worker]]"
  - "[[projects/werk/docs/entities/systems/Orchestrator|Orchestrator]]"
  - "[[projects/werk/docs/entities/systems/Factory|Factory]]"
rules:
  - "[[Feature Request Validation]]"
prev_step:
next_step: "[[Pre-Production]]"
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
The System provides the [[Webview Intake Form]] for the [[System User]] to input a new [[Feature Request]].