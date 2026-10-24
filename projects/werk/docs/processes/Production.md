---
type: Process
actors:
  - "[[AI-Agent]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 3
inputs:
  - "[[Feature Request]]"
outputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[New Increment Created]]"
  - "[[Process Updated]]"
supplier:
  - "[[Git Repository]]"
customers:
  - "[[Worker]]"
  - "[[AI-Agent]]"
rules:
  - "[[Definition of Done]]"
prev_step: "[[Pre-Production]]"
next_step: "[[Post-Production]]"
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
