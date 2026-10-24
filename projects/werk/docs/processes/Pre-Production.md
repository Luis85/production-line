---
order: 2
prev_step: "[[Intake]]"
next_step: "[[Production]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[Process Updated]]"
inputs:
  - "[[Feature Request]]"
outputs: "[[Feature Request]]"
rules:
  - "[[Definition of Ready]]"
actors:
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
owner: "[[Worker]]"
supplier:
  - "[[Worker Queue]]"
  - "[[Git Repository]]"
customers:
  - "[[Worker]]"
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
