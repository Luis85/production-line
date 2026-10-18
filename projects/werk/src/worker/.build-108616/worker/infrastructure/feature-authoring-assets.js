import { featureTaskDirectory,                                   } from '../application/feature-workflow.js';
                                                                      
import { stringify } from 'yaml';

export function authoringTemplateFor(provider             = 'codex-cli')         {
  return `---
schemaVersion: 1
templateId: feature-request-v1
title: Describe the feature
status: draft
mode: patch
provider: ${JSON.stringify(provider)}
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
}


export function authoringBase(config                              )         {
  const folder = (path        ) => `file.folder == ${JSON.stringify(path)}`;
  const requests = folder(config.requestsDirectory), reviews = folder(config.reviewDirectory), tasks = folder(featureTaskDirectory(config));
  return stringify({
    filters: { and: ['file.ext == "md"', '!file.name.startsWith("_")', { or: [requests, reviews, tasks] }] },
    properties: {
      'note.id': { displayName: 'Request ID' }, 'note.title': { displayName: 'Feature' },
      'note.status': { displayName: 'Status' }, 'note.priority': { displayName: 'Priority' },
      'note.werkOwner': { displayName: 'Worker' }, 'note.werkTask': { displayName: 'Your next action' },
      'note.werkPullRequest': { displayName: 'Review' }, 'note.featureId': { displayName: 'Feature ID' },
      'note.action': { displayName: 'Response action' }, 'file.mtime': { displayName: 'Updated locally' },
    },
    views: [
      { type: 'table', name: 'Team feature requests', filters: { and: [requests] },
        order: ['file.name', 'note.title', 'note.status', 'note.priority', 'note.werkOwner', 'note.werkTask', 'note.werkPullRequest', 'note.id', 'file.mtime'],
        sort: [{ property: 'note.priority', direction: 'ASC' }, { property: 'file.name', direction: 'ASC' }] },
      { type: 'table', name: 'Human tasks', filters: { and: [tasks, 'type == "Task"'] },
        order: ['file.name', 'note.status', 'note.featureId', 'note.action', 'file.mtime'] },
      { type: 'table', name: 'Pull requests', filters: { and: [reviews, 'type == "PullRequest"'] },
        order: ['file.name', 'note.title', 'note.status', 'note.featureId', 'file.mtime'] },
    ],
  });
}

export function authoringSkill()         {
  return `---
name: create-feature-request
description: Create Feature Request — author, validate, and explicitly queue a project feature request using the committed template and checks, without a running Werk worker.
---

# Create Feature Request

Work from the repository root. Read .werk/feature-workflow.json, its editable
template, fr-ready-check.json and fr-done-check.json (or their configured paths).
The team queue is the configured Obsidian Base. Node 24 is the only runtime needed;
no worker connection, provider credentials, or npm install is required. These
authoring commands do not dispatch a model. Shared work starts only after the
ready request is committed and pushed to the worker’s configured intake branch.

1. Clarify the desired outcome, affected users, scope, acceptance criteria, and
   verification evidence with the author. Ask about missing details; do not invent
   decisions or mark unanswered questions as complete.
2. Run \`node .werk/authoring/feature-request.mjs create --name NAME.md --title "Feature title"\`.
   This copies the current template and creates a stable ID in a new draft. Never
   reuse another request's ID. Edit that draft's Goal, Context, Acceptance criteria,
   and Verification plan. Shared requests use patch mode with an explicit approved
   paths list. Keep the template’s explicit provider unless the author selects
   another connection available on the worker. Keep the body within 8,000 characters.
3. Run \`node .werk/authoring/feature-request.mjs validate --file QUEUE/NAME.md\`.
   Resolve every reported readiness failure, then run validation again. Configured
   checks are deterministic and shared with worker intake. A draft with missing
   details stays draft even if prose says it is ready.
4. Only when the author intends to queue this request, run
   \`node .werk/authoring/feature-request.mjs ready --file QUEUE/NAME.md --if-match REVISION\`
   using the revision from validation. This rechecks the current document and policy
   before changing draft to ready. A stale revision requires rereading and validating.
5. When authorized to share the request, commit and push it through the team’s
   normal Git workflow to the configured intake branch. A local save or commit
   alone does not submit shared work. Do not force-push concurrent changes.
6. Pull that branch to follow the original request’s worker progress, linked Task
   and PullRequest notes. A Task with an answer/resume action has one editable
   \`## Answer\` section. Supply only an answer or continuation authorized by the
   user, change that Task’s status to ready, then commit and push it. Keep its
   identity, question, action and expectedRevision unchanged. Wait for processed
   acknowledgement; on error, read the reason and reconcile before retrying.
   A blocked diagnostic Task describes operator work; marking it ready cannot
   grant tools, attest completion or bypass a gate.

Never change an accepted feature request or worker-owned note identity/evidence,
forge execution/review evidence, supply secrets in a request or response, or
weaken checks to pass a request. Create a new successor draft for changed work.
Completion checks and review notes describe evidence; a model response or a checked
Markdown box is not trusted test evidence, permission to merge, or human approval.
A PullRequest Markdown note is a review handoff, not a hosting-service PR or merge
approval. Worker Git publication does not merge the feature branch; humans review before merge.
`;
}
