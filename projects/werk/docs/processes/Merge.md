---
type: Process
actors:
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 6
inputs:
  - "[[Feature Request]]"
  - "[[Pull Request]]"
  - "[[Increment]]"
outputs:
  - "[[Feature Request]]"
  - "[[Pull Request]]"
  - "[[Increment]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[Pull Request Updated]]"
  - "[[Increment Updated]]"
  - "[[Process Updated]]"
supplier:
  - "[[Git Repository]]"
  - "[[System User]]"
customers:
  - "[[Worker]]"
  - "[[System User]]"
  - "[Factory](../entities/systems/Factory.md)"
  - "[Orchestrator](../entities/systems/Orchestrator.md)"
prev_step: "[[Review]]"
next_step: "[[Build]]"
status: Open
owner: "[[System]]"
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

# Merge

The worker uses the configured GitHub repository, base and merge method. Before mutation it persists an operation intent and verifies the intended owned PR and expected candidate head, required acceptance and policy approval. Repository branch protection and host review rules remain authoritative.

## Exit and recovery

A confirmed merge receipt contains the PR number and actual merged commit. Squash/rebase results are identified from the hosting service rather than assuming the candidate SHA is the integrated SHA. That exact receipt becomes Build's source.

Conflicts, changed heads, closed-without-merge and unavailable host checks block this step. A lost acknowledgement retains an unknown outcome; read-only reconciliation confirms the matching merge or its absence before a new explicit mutation. Merge does not mark the release published.
