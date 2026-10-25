---
type: System
extends: "[[Base Entity]]"
description:
status:
color:
category:
parent: "[Orchestrator](Orchestrator.md)"
aliases:
tags:
emits:
  - "[[New Pull Request]]"
  - "[[Pull Request Updated]]"
  - "[[Feature Request Updated]]"
  - "[[New Increment Created]]"
  - "[[Increment Updated]]"
subscribes:
  - "[[New Feature Request]]"
  - "[[Feature Request Updated]]"
order: 42125
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

# Worker

The Worker owns Feature Request intake, approved model execution, isolated candidate workspaces, verification and traceable delivery. It runs independently; enrollment in an Orchestrator adds assignments without becoming a prerequisite for the standalone workflow.

A configured worker home/state directory holds its durable private state and managed projects. Registering a remote repository clones its configured shared branch into a project-specific checkout. Explicit adoption can register an existing checkout without relocating it or overwriting user changes. Retained requests keep their project/repository identity.

Managed projects live beneath `projects/<project-id>/checkout` inside the worker state directory; candidate worktrees live inside their corresponding project by default. Existing explicitly configured external worktree locations retain their documented restrictions. Project templates, readiness/completion rules, checks and release policy are versioned; local operator approval authorizes the exact committed policy.

Webview, CLI and Markdown expose the same request lifecycle and durable operation receipts. The primary flow advances through Intake, Pre-Production, Production, Post-Production, Review, Merge, Build and Publish. It presents missing, stale, failed and unknown evidence as actionable state and never substitutes simulation for live provider or release qualification.

See [workflow contracts](../../reference/worker-release-workflow.md), [operating guide](../../how-to/deliver-worker-release.md) and [execution modes](../../explanation/modes.md).
