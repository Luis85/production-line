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
order: 62000
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

# Increment

An Increment identifies one immutable candidate produced for a Feature Request: accepted request/input revision, delivery run, baseline, branch, candidate commit/tree/digest, policy/check-definition digests and verification evidence.

One request can retain several increments through repair or review feedback. Only the current verified increment can receive current-candidate acceptance. Earlier candidates remain historical evidence and do not inherit newer approvals. The same owned PR can carry successive increments.

A merged increment links its actual merged commit to a separate build manifest and release receipt. A candidate, accepted request, merged commit and published release are distinct recorded milestones.
