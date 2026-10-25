---
type: Process
actors:
  - "[[Worker]]"
interfaces:
  - "[[Webview Kanban Board]]"
  - "[[Command Line]]"
order: 4
inputs:
  - "[[Feature Request]]"
  - "[[Increment]]"
outputs:
  - "[[Feature Request]]"
  - "[[Pull Request]]"
  - "[[Increment]]"
emits:
  - "[[New Pull Request]]"
  - "[[Increment Updated]]"
  - "[[Process Updated]]"
supplier:
  - "[[Git Repository]]"
  - "[[Worker Queue]]"
  - "[[Increment Verification Pipeline]]"
customers:
  - "[[Worker]]"
prev_step: "[[Production]]"
next_step: "[[Review]]"
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

# Post-Production

The worker executes the configured Increment Verification Pipeline against the exact candidate. Evidence records the accepted request revision, candidate tree/commit, check definition, environment and observation time. Required missing, failing or stale evidence blocks review publication.

If verification fails, rework returns to Production within the accepted repair allowance. Exhausted repair remains a visible hold with the retained candidate and failed checks. Once required checks pass, the worker packages quality reports and creates the initial remote PR through its separately authorized publication action.

## Exit and recovery

One owned PR is retained through review feedback and later candidate updates. Rework uses an expected remote head; an unrelated branch or raced update is never overwritten. New candidate content invalidates earlier check/acceptance evidence. Lost push/PR acknowledgements reconcile saved intent against the remote before any further mutation.

The older imported line-publisher requirement to open a draft PR before implementation describes a separate orchestrator slice. This standalone primary workflow creates its initial PR after verification.
