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

The worker executes the configured Increment Verification Pipeline against the exact candidate. Evidence records accepted request revision, candidate tree/commit, check definition, environment and observation time. Required missing, failing or stale evidence blocks the review handoff.

If verification fails, rework returns to Production within the accepted repair allowance; exhausted repair remains a visible hold. Once required checks pass, the worker packages quality reports and produces the PullRequest Markdown file. Shared Git delivery confirms the source/review branch and Markdown publication; local delivery retains its candidate and review package locally.

## Exit and recovery

Default delivery needs ordinary Git, not a hosting-service API. Feedback retains the same Feature Request and fresh candidate evidence. New candidate content invalidates earlier checks and human acceptance. Shared publication reconciles its saved Git intent/acknowledgement before dispatching further work.

If a project explicitly enables GitHub PR integration through committed policy and exact local approval, an authorized action can create the initial hosting-service PR after verification. Later verified rework updates the same owned open PR using its retained expected remote head; unrelated or raced heads are never overwritten. A GitHub URL or installed `gh` does not enable that action.

The older imported line-publisher requirement to open a draft host PR before implementation remains a separate orchestrator slice.
