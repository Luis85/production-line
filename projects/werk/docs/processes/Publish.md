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

The worker publishes the retained build assets to the project's configured GitHub repository and release tag. It records intent before remote mutation, verifies source/tag identity, and confirms expected asset names, sizes and SHA-256 digests before recording publication success.

The release policy defines destination, tag prefix and prerelease behavior. Credentials stay in the worker account's host authentication, outside request Markdown, prompts and release assets. A human decision or approved explicit release action controls publication independently of candidate acceptance.

## Exit and recovery

The full workflow completes only after a confirmed published release receipt links the request, reviewed candidate, merged commit, build manifest and release URL. A draft or partial upload remains incomplete. Existing unrelated tags, releases or differing assets are conflicts; an already published release is not overwritten to make a retry pass.

After a lost acknowledgement, reconcile the saved operation read-only. Reuse matching remote results; request another explicit mutation only after absence is established. Failed publication preserves the verified build and last successful milestone.
