import type { FeatureWorkflowConfiguration } from '../application/feature-workflow.js';

export const authoringTemplate = `---
schemaVersion: 1
templateId: feature-request-v1
title: Describe the feature
status: draft
mode: patch
paths: []
priority: 1
---
# Goal

<!-- Explain the problem, who experiences it, and the observable outcome. -->

## Context

<!-- Describe constraints, relevant behavior, and what is outside this request. -->

## Acceptance criteria

<!-- Add one or more concrete, verifiable checklist items. -->

## Verification plan

<!-- Explain how each outcome will be checked and what evidence reviewers need. -->
`;

export function authoringBase(config: FeatureWorkflowConfiguration): string {
  // JSON strings are also valid YAML scalars; paths never become executable expressions.
  return `filters:\n  and:\n    - ${JSON.stringify(`file.folder == ${JSON.stringify(config.requestsDirectory)}`)}\n    - 'file.ext == "md"'\n    - '!file.name.startsWith("_")'\nproperties:\n  note.id:\n    displayName: Request ID\n  note.title:\n    displayName: Feature\n  note.status:\n    displayName: Status\n  note.priority:\n    displayName: Priority\n  file.mtime:\n    displayName: Updated locally\nviews:\n  - type: table\n    name: Team feature requests\n    order:\n      - file.name\n      - note.title\n      - note.status\n      - note.priority\n      - note.id\n      - file.mtime\n    sort:\n      - property: note.priority\n        direction: ASC\n      - property: file.name\n        direction: ASC\n`;
}

export function authoringSkill(): string {
  return `---
name: create-feature-request
description: Create Feature Request — author, validate, and explicitly queue a project feature request using the committed template and checks, without a running Werk worker.
---

# Create Feature Request

Work from the repository root. Read .werk/feature-workflow.json, its editable
template, fr-ready-check.json and fr-done-check.json (or their configured paths).
The team queue is the configured Obsidian Base. Node 24 is the only runtime needed;
no worker connection, provider credentials, npm install, or model invocation is needed.

1. Clarify the desired outcome, affected users, scope, acceptance criteria, and
   verification evidence with the author. Ask about missing details; do not invent
   decisions or mark unanswered questions as complete.
2. Run \`node .werk/authoring/feature-request.mjs create --name NAME.md --title "Feature title"\`.
   This copies the current template and creates a stable ID in a new draft. Never
   reuse another request's ID. Edit that draft's Goal, Context, Acceptance criteria,
   and Verification plan. Shared requests use patch mode with an explicit approved
   paths list. Keep the body within 8,000 characters.
3. Run \`node .werk/authoring/feature-request.mjs validate --file QUEUE/NAME.md\`.
   Resolve every reported readiness failure, then run validation again. Configured
   checks are deterministic and shared with worker intake. A draft with missing
   details stays draft even if prose says it is ready.
4. Only when the author intends to queue this request, run
   \`node .werk/authoring/feature-request.mjs ready --file QUEUE/NAME.md --if-match REVISION\`
   using the revision from validation. This rechecks the current document and policy
   before changing draft to ready. A stale revision requires rereading and validating.
5. Commit the request and use the team's normal Git review/push workflow when the
   author asks to share it. Authoring does not require contacting a worker. A worker
   connected to this repository can discover the committed ready request later.

Never change a worker-owned request (source/werk metadata or a lifecycle status
other than draft), forge execution/review evidence, supply secrets in a request, or
weaken checks to pass a request. Create a new successor draft for changed work.
Completion checks and review notes describe evidence; a model response or a checked
Markdown box is not trusted test evidence, permission to merge, or human approval.
Worker Git publication does not merge the feature branch; humans review before merge.
`;
}
