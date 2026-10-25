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
  - "[[Process Updated]]"
supplier:
  - "[[System User]]"
customers:
  - "[[System User]]"
rules:
prev_step:
next_step: "[[Worker Intake]]"
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

# Direct Feature Request to a Worker

The primary standalone workflow is Worker Intake → Pre-Production → Production → Post-Production → Review → Merge → Build → Publish. It uses one stable Feature Request identity and retained candidate increments throughout.

## Prerequisites

Run a native worker, register or explicitly adopt its project repository, configure Claude Code CLI and its approved tools, commit and approve the delivery policy, and configure the GitHub release destination. Windows with Claude Code CLI is the live acceptance target; fixture runs qualify only the boundaries they actually exercise.

## Completion

The full release path completes only after the exact merged source has a successful build and its expected GitHub Release assets are observed. The worker exposes the current phase, wait reason, evidence and next allowed action in the request detail, Markdown projection and CLI.

Each step below has its own entry/exit and recovery contract. See [the runtime reference](../reference/worker-release-workflow.md) and [operating guide](../how-to/deliver-worker-release.md).
