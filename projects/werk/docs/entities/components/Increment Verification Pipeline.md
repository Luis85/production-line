---
type: Pipeline
extends: "[[Pipeline]]"
parent: "[[Worker]]"
emits:
subscribes:
color:
tags:
aliases:
category:
description:
status:
relations:
---

# Increment Verification Pipeline

A versioned project quality profile selects required independent checks and acceptance criteria. Each result binds the request/input revision, candidate commit/tree/digest, policy/check-definition digest, evaluator, environment and time.

Build/test results use observed exit status and retained evidence. Model statements, missing output and unavailable observations cannot pass a gate. Relevant code, baseline, input or check-definition changes make prior results stale. Manual criteria and authorized criterion decisions are recorded separately from automated observations.

Failure returns to bounded repair or a visible hold. Passing verification produces an immutable review package; merge and release remain separate evidence boundaries. See [Definition of Done](../../../quality/Definition%20of%20Done.md) and the [workflow contract](../../reference/worker-release-workflow.md).
