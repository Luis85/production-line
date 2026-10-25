---
type: Process
actors:
  - "[[System User]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 8
inputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
outputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
emits:
  - "[[Feature Request Updated]]"
  - "[[Increment Updated]]"
  - "[[Process Updated]]"
supplier:
  - "[[System User]]"
  - "[[Git Repository]]"
customers:
  - "[[Worker]]"
  - "[[System User]]"
  - "[Factory](../entities/systems/Factory.md)"
  - "[Orchestrator](../entities/systems/Orchestrator.md)"
prev_step: "[[Build]]"
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

# Publish

Default worker delivery publishes the review handoff through Git: shared intake confirms its implementation/source and review branches and PullRequest Markdown evidence; local intake retains the candidate/review package for the team's chosen push workflow. Later application publication is the team's normal project workflow. No hosting-service PR, GitHub Release or deployment is implied by the handoff.

## Optional GitHub Release publication

Explicit committed and locally approved GitHub release policy can authorize publication of a retained managed build to the configured repository/tag. The worker records intent before mutation and confirms source/tag, release visibility and expected asset names, sizes and SHA-256 digests before reporting success.

Its release-enabled lifecycle completes only after the confirmed receipt links request, reviewed candidate, actual merged commit, build manifest and release URL. Draft/partial uploads remain incomplete; unrelated tags/releases or differing assets are conflicts. A published release is not destructively replaced to make a retry pass. Lost acknowledgements use read-only reconciliation before another authorized mutation.

A GitHub repository URL, installed/authenticated `gh` or provider login alone does not opt into this extension. Credentials remain outside request Markdown, prompts and assets.
