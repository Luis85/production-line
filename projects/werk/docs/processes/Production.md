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
  - "[[Start Prompt]]"
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
  - "[[Webview Kanban Board]]"
  - "[[Worker Queue]]"
rules:
  - "[[Definition of Done]]"
prev_step: "[[Pre-Production]]"
next_step: "[[Post-Production]]"
status: Open
owner: "[[Worker]]"
parent: "[[Direct Feature Request to a Worker through the Webview Worker Intake]]"
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
Once the [[Definition of Ready]] are met, the worker dispatches the [[Start Prompt]] to the [[AI-Agent]].
The worker updates the [[Feature Request]].
The agent informs the worker once done. 