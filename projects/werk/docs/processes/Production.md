---
order: 3
prev_step: "[[Pre-Production]]"
next_step: "[[Post-Production]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[New Increment Created]]"
  - "[[Process Updated]]"
inputs:
  - "[[Feature Request]]"
outputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
rules:
  - "[[Definition of Done]]"
actors:
  - "[[AI-Agent]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
owner: "[[Worker]]"
supplier:
  - "[[Git Repository]]"
customers:
  - "[[Worker]]"
  - "[[AI-Agent]]"
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
