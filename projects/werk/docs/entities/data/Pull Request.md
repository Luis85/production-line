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

The hosting-service PR belongs to a stable Feature Request and configured repository/base. Its current published head identifies the candidate presented for human review. A Markdown PullRequest note is the review handoff and projection; it is not itself a GitHub PR.

The initial hosting-service PR follows successful independent verification. Later verified rework updates the same owned branch/PR with an expected-head guard. Reviews and evidence are bound to the current candidate; unrelated remote changes cause a conflict.

Remote state (open, closed, merged), merge commit and release milestones are observed separately. Closed-without-merge cannot complete the integration step. Unknown mutation outcomes retain their intent until reconciled.
