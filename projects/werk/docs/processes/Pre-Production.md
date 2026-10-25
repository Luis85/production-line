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
outputs:
  - "[[Feature Request]]"
  - "[[Start Prompt]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[Process Updated]]"
supplier:
  - "[[Worker Queue]]"
  - "[[Git Repository]]"
customers:
  - "[[Worker]]"
  - "[[AI-Agent]]"
  - "[[Git Repository]]"
rules:
  - "[[Definition of Ready]]"
prev_step: "[[Worker Intake]]"
next_step: "[[Production]]"
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

# Pre-Production

The worker pins the accepted Feature Request revision, repository baseline, execution profile, check definitions, tool grants and runtime/repair limits. It creates an owned feature branch and an isolated worktree beneath the corresponding managed project, prepares the configured development environment, and retains the start prompt and dispatch identity.

Setup commands come from approved project/machine configuration. Request Markdown cannot introduce unrestricted commands or credentials. Project dependencies and required tools are checked before Claude Code is invoked.

## Exit and recovery

Production starts only when the isolated workspace and immutable dispatch are ready and [Definition of Ready](../../quality/Definition%20of%20Ready.md) passes. Failed setup preserves diagnostics and partial-work identity. After interruption the worker verifies its saved workspace; an uncertain earlier operation is reconciled before another mutation. The developer's checkout and staging area remain outside candidate execution.
