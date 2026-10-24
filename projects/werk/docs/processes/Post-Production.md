---
type: Process
actors:
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 4
inputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
outputs:
  - "[[Feature Request]]"
  - "[[Pull Request]]"
  - "[[Increment]]"
emits:
  - "[[New Pull Request]]"
  - "[[Increment Updated]]"
  - "[[Process Updated]]"
supplier:
  - "[[Git Repository]]"
  - "[[Worker Queue]]"
customers:
  - "[[Worker]]"
prev_step: "[[Production]]"
next_step: "[[Review]]"
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
