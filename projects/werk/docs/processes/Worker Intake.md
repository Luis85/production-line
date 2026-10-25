---
type: Process
actors:
  - "[[System User]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Intake Form]]"
  - "[[Command Line]]"
order: 1
inputs:
  - "[[Feature Request]]"
  - "[[Project]]"
  - "[[Git Repository]]"
  - "[[Priority]]"
  - "[[Feature Request Template]]"
outputs:
  - "[[Feature Request]]"
emits:
  - "[[New Feature Request]]"
  - "[[Process Updated]]"
supplier:
  - "[[System User]]"
customers:
  - "[[Worker]]"
  - "[Orchestrator](../entities/systems/Orchestrator.md)"
  - "[Factory](../entities/systems/Factory.md)"
  - "[[Webview Kanban Board]]"
  - "[[Worker Queue]]"
  - "[[Git Repository]]"
rules:
  - "[[Feature Request Validation]]"
prev_step: "[[Direct Feature Request to a Worker through the Webview Worker Intake]]"
next_step: "[[Pre-Production]]"
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

# Worker Intake

The user selects a registered project and a project/default Feature Request template, gives the request a title and Markdown outcome, and chooses High, Medium or Low priority; the default is Low. Project selection supplies its repository identity. These feature priorities are separate from backlog P0/P1 labels.

The worker validates the document, retains one stable request ID, saves its canonical Markdown and returns process feedback. Draft/readiness findings preserve the author's text. The queued request appears on the Kanban board with its next required action.

For shared Git intake, publishing the ready document to the configured intake branch and confirming a durable claim precede implementation. The intake branch and implementation base are explicit project settings; protected-base permissions are not bypassed.

## Exit and recovery

Continue only after the request has passed its selected readiness policy and the accepted input, project policy and repository baseline are retained. Identical command retries reuse the receipt. Conflicting payloads, duplicate request IDs, failed publication and ambiguous sources block new dispatch and remain visible.
