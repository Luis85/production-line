---
type: Process
actors:
  - "[[System User]]"
  - "[[System]]"
interfaces:
  - "[[Webview Intake Form]]"
  - "[[Webview Kanban Board]]"
order: 0
inputs:
  - "[[Feature Request]]"
outputs:
  - "[[Increment]]"
emits:
supplier:
  - "[[System User]]"
customers:
  - "[[System User]]"
rules:
prev_step:
next_step:
status: Open
owner: "[[System]]"
parent: "[[Processes]]"
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
## Prerequisites

- The user has a running worker instance
