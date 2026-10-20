import { featureTaskDirectory, type FeatureWorkflowConfiguration } from '../application/feature-workflow.js';
import type { ProviderId } from '../application/provider-contract.js';
import { stringify } from 'yaml';

export function authoringTemplateFor(provider: ProviderId = 'codex-cli'): string {
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


export function authoringReadyReviewPrompt(): string {
  return '# Feature Request Ready Check\n\nReview this Feature Request for clear intent, complete decisions, explicit scope and verifiable acceptance criteria. Identify contradictions, gaps and unanswered questions before implementation. Ask focused questions the team can answer in this Feature Request; do not invent their decisions.\n\nReview the team’s answers on each subsequent attempt and preserve unresolved concerns. Follow the worker’s review response format. Do not implement the feature, grant tools, alter its approved scope or claim deterministic readiness checks passed.\n';
}

export function authoringDefinitionPrompt(stage: 'ready' | 'done'): string {
  return stage === 'ready'
    ? '# Definition of Ready\n\nBefore implementing, confirm that the request provides a clear goal, acceptance criteria, approved file scope and verification plan. Ask for missing decisions that prevent safe implementation; do not invent requirements.\n\nFollow the worker’s execution policy and configured ready checks. This prompt does not grant additional tools or file access.\n'
    : '# Definition of Done\n\nCheck each acceptance criterion and run the agreed verification within the approved scope. Report the changed behavior, evidence, remaining limitations and any checks that could not run. Do not claim tests passed without observed results.\n\nFollow the worker’s configured completion checks and prepare the work for human review. This prompt does not approve or merge the implementation.\n';
}

export function authoringBase(config: FeatureWorkflowConfiguration): string {
  const folder = (path: string) => `file.folder == ${JSON.stringify(path)}`;
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

export function authoringSkill(): string {
  return `---
name: create-feature-request
description: Create Feature Request — author, validate, and explicitly queue a project feature request using the committed template and checks, without a running Werk worker.
---

# Create Feature Request

First inspect .werk/worker.json when present. If features.intake is local, use
this local workflow instead of the shared Git steps below:

1. Read the configured feature folder's _templates/local-request.md. Copy it as
   a new request in that folder, choose a unique stable id, and keep intent: draft.
   Use schema: worker.request/v1, mode: patch, explicit approved paths, and the
   project quality_profile. Clarify Outcome, Scope, Acceptance criteria,
   Boundaries and References; never invent missing decisions or broaden scope.
2. When the author explicitly submits the work, set intent: submit. No running
   worker connection or webview is needed to author or save the note. Its local
   worker observes the note when running; it retains one Feature Request identity.
3. Follow the same note's Worker region. Answer stable question IDs in Answers.
   Editing requirements or answers creates a reassessed revision; leave generated
   status/evidence untouched. Done/cancelled requests require a fresh control
   command_id with action: reopen. An ordinary edit never reopens them.
4. Inspect the candidate-linked review note. A review command must name the exact
   request_revision and candidate_commit and record required human_checks. Use a
   new command_id for each decision; never fabricate test outcomes or acceptance.

For a shared Git project, retain the existing shared template and workflow:

Work from the repository root. Read .werk/feature-workflow.json, its editable
template, fr-ready-check.json and fr-done-check.json (or their configured paths).
Also read readyPrompt and donePrompt when configured; these Markdown or text files
provide the team’s Definition of Ready and Definition of Done to dispatched models.
When readyReviewPrompt is configured, read its separate Feature Request Ready Check
prompt too. Offline authoring validates files but does not dispatch this reviewer.
After commit and push, the worker reviews the request before implementation.
Answer reviewer questions in the generated Feature Request Ready Check section’s
Answers subsection. Set that same Feature Request to ready, then commit and push
the answers for another review. Preserve worker-owned findings and metadata.
Definition guidance supplements the deterministic JSON checks and never grants tools,
file access or authority to merge. Omitted prompt paths leave existing behavior unchanged.
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
   Resolve every reported validation failure, then validate again. When
   readyReviewPrompt is configured, this checks safe structural eligibility for
   review; semantic gaps and missing decisions can reach the reviewer. Otherwise
   it applies the project’s full deterministic readiness checks. A successful
   structural check does not establish Definition of Ready or start implementation.
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

For the legacy shared workflow, never change an accepted feature request or worker-owned note identity/evidence,
forge execution/review evidence, supply secrets in a request or response, or
weaken checks to pass a request. Create a new successor draft for changed work.
Completion checks and review notes describe evidence; a model response or a checked
Markdown box is not trusted test evidence, permission to merge, or human approval.
A PullRequest Markdown note is a review handoff, not a hosting-service PR or merge
approval. Worker Git publication does not merge the feature branch; humans review before merge.
`;
}
