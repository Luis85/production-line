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

# Production

The worker dispatches the retained start prompt to its selected AI agent in the prepared candidate workspace. Claude Code CLI is the primary native Windows acceptance provider; other configured adapters retain their own documented platform/capability limits.

Progress, questions, invocation identities, usage coverage and bounded process observations remain associated with the same Feature Request and delivery run. The worker mediates approved tools and enforces configured time, capacity and repair limits.

## Exit and recovery

A model completion message advances the candidate to independent Post-Production verification; it does not establish passing checks. Questions wait for a guarded answer. Known failure can enter a bounded retry or repair; unknown process outcome requires explicit inspection/reconciliation before another invocation. Cancel and interrupt preserve inspectable partial work and report observed outcomes truthfully.
