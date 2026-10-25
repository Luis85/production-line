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

The default standalone worker retains one Feature Request through Worker Intake → Pre-Production → Production → Post-Production → Review. Its PullRequest is a Markdown handoff carrying candidate identity, Git branches and quality reports. Shared intake publishes that handoff through ordinary Git; local intake retains its candidate and review package locally. A person reviews the delivered increment and explicitly allows the worker to merge it into the displayed main checkout.

## Prerequisites

Extract the complete runtime archive into a dedicated worker home and start its `worker.mjs` entry point. In the webview, register the project, preview/approve its workflow setup Git commit/push, configure the selected provider/tools, approve the exact committed policy and recheck setup. GitHub API access and GitHub CLI are not prerequisites. A GitHub repository URL, installed `gh` or provider login does not enable host integration.

## Completion and optional downstream stages

The primary journey follows Kanban, Git commit/push observations, webview activity and same-Feature-Request updates through review. Newly generated setup uses `localMerge: true`: acceptance alone leaves delivery in progress until the user-authorized merge into the exact displayed main checkout is confirmed. The handoff note cannot manufacture permission or success.

Plain-Git main-checkout merge is part of this primary journey. Later Build → Publish remain the team's normal project workflow unless a separate extension is enabled. Explicit committed and locally approved GitHub integration can let the worker manage those stages and retain their exact receipts; its release-enabled lifecycle completes only after the expected release assets are confirmed. Windows with Claude Code CLI and GitHub Releases remains the selected optional live pilot.

Follow [the archive-to-main-checkout tutorial](../tutorials/worker-home-to-main.md). See [the delivery contract](../reference/worker-release-workflow.md) and the [optional GitHub operating guide](../how-to/deliver-worker-release.md).
