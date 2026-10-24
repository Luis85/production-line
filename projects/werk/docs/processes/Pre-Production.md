---
type: Process
actors:
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 2
inputs:
  - "[[Feature Request]]"
outputs: "[[Feature Request]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[Process Updated]]"
supplier:
  - "[[Worker Queue]]"
  - "[[Git Repository]]"
customers:
  - "[[Worker]]"
rules:
  - "[[Definition of Ready]]"
prev_step: "[[Intake]]"
next_step: "[[Production]]"
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
