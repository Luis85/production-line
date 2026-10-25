---
type: Process
actors:
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 7
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
  - "[[Git Repository]]"
  - "[[System User]]"
customers:
  - "[[Worker]]"
  - "[[System User]]"
  - "[Factory](../entities/systems/Factory.md)"
  - "[Orchestrator](../entities/systems/Orchestrator.md)"
prev_step: "[[Merge]]"
next_step: "[[Publish]]"
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

# Build

The worker prepares an isolated build workspace at the confirmed merged commit and runs the project-configured build executable and arguments within the approved timeout. The build definition is retained with the accepted delivery policy; feature text cannot replace it.

The successful result retains source commit, build operation identity, environment, artifact relative paths, byte counts and SHA-256 digests. Artifacts must exist as bounded regular files within the owned build workspace. Missing files, unsafe paths, nonzero exit and timeout fail this step.

## Exit and recovery

Publish is available only for a successful retained build and matching source/artifacts. A failed post-merge build preserves the merge receipt and reports a release blocker; it does not claim the source was unmerged or silently rerun implementation. Interruption preserves an uncertain build outcome for reconciliation; a retry uses a new guarded action after the previous result is known.
