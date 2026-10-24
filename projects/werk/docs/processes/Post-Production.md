---
order: 4
prev_step: "[[Production]]"
next_step: "[[Review]]"
emits:
  - "[[New Pull Request]]"
  - "[[Increment Updated]]"
  - "[[Process Updated]]"
inputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
outputs:
  - "[[Feature Request]]"
  - "[[Pull Request]]"
  - "[[Increment]]"
actors:
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
owner: "[[Worker]]"
supplier:
  - "[[Git Repository]]"
  - "[[Worker Queue]]"
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
