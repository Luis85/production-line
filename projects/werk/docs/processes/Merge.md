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

The primary Git/Markdown workflow asks a person to review the exact increment, then explicitly allow the worker to merge into the displayed assigned main checkout. The decision binds candidate revision/digest and destination path, branch and prior head. The worker requires a clean target checkout/index, rejects conflicts or stale state, and retains its prepared intent before guarded Git ref/worktree mutation. It does not force-reset or discard user work.

A confirmed local-merge receipt records the resulting main-checkout state. A handoff or candidate acceptance alone does not establish that result. Unknown acknowledgements use read-only reconciliation before another mutation. New `localMerge: true` workflow policies require this confirmation before delivery completes; older review-only policies retain their established semantics. This needs Git, not GitHub APIs or GitHub CLI.

## Optional managed GitHub merge

Explicit committed and locally approved GitHub release policy can enable worker-managed merge. Before mutation the worker persists intent and verifies its owned PR, configured repository/base, expected candidate head, required acceptance and current approval. For an owned draft PR, the explicit merge action can mark it ready, then reobserve the head and authorization before expected-head merge. Repository branch protection and host review rules remain authoritative.

A confirmed receipt records the actual merged commit, including the host's squash/rebase result, for the optional managed Build step. Conflicts, changed heads, closed-without-merge or unavailable host checks block the action. Lost acknowledgement retains an unknown outcome for read-only reconciliation before another mutation.
