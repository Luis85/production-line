---
type: Data
extends: "[[Data]]"
description:
status:
color:
category: Value Objects
parent: "[[Worker]]"
relations:
aliases:
tags:
order: 63375
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

# Pull Request

The default PullRequest is a Markdown file belonging to the stable Feature Request. It is the review handoff: accepted outcome, implementation/source and review Git branches, exact candidate and quality evidence. Shared intake publishes it through ordinary Git; local intake retains its review package locally. A person reviews the delivered increment and explicitly allows the worker to merge the exact candidate into the displayed assigned main checkout, without a GitHub API prerequisite.

A hosting-service PR is a separate optional artifact. Explicit committed integration policy and exact local approval enable its creation after verification. A GitHub repository URL or installed `gh` is not consent. When enabled, verified rework retains the same owned open host PR and guards updates against its expected prior head; stale checks/acceptance cannot transfer to changed code.

Optional host state, actual merge commit and release milestones are observed separately. A Markdown handoff, closed PR or local acceptance does not prove integration or publication. Unknown mutation outcomes retain intent until reconciled.
