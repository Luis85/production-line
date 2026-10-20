import { inputError } from '../config.mjs';

export const localTemplateName = '_templates/local-request.md';
/** Reads --intake; absent means "keep what the project has, otherwise shared". */
export function intakeOption(value) {
  if (value === undefined) return undefined;
  if (value !== 'shared' && value !== 'local') throw inputError('--intake must be shared or local. Use --intake local only for an operator-only worker that takes requests from its feature folder.');
  return value;
}
/** Local folder intake refuses a templateId, so this operator template carries none. */
export function localRequestTemplate(provider) {
  const template = `---
schema: worker.request/v1
id: FR-0001
title: Describe the feature
intent: draft
mode: patch
paths: [src/]
priority: normal
quality_profile: feature
depends_on: []
---
# Describe the feature

## Outcome

Describe the desired result and who needs it.

## Scope

Describe the included changes.

## Acceptance criteria

- AC-01: Describe an observable result.

## Boundaries

Describe constraints and excluded changes.

## References

Link relevant project documents.

## Answers

Answer worker questions here using their IDs.

<!-- worker:begin -->
## Worker

Status: Draft
<!-- worker:end -->
`;
  return template.replace('mode: patch', `mode: patch
provider: ${JSON.stringify(provider)}
# Choose a unique request ID and review the approved paths before submission.
# Local requests have no templateId; shared Git requests use their separate team template.`);
}
/** `relative` is the project-relative POSIX path used in the copy-paste commands. */
export function localIntakeResult(template, relative) {
  const cli = 'node bin/apps/worker/cli.mjs', request = 'request.md', draft = 'request-draft.md';
  return {
    mode: 'local', connectionRequired: false, template,
    source: 'Requests are Markdown files in the feature folder; shared Git intake is intentionally off and repository watching defaults to off.',
    commands: { copy: `Copy ${relative} to ${draft} outside the feature folder, choose a unique id, review paths, and edit the title and body.`, create: `${cli} feature create --name ${request} --markdown ${draft}`, validate: `${cli} feature validate --name ${request}`, submit: `${cli} feature submit --name ${request} --if-match REVISION` },
    next: `Start the worker. Copy ${relative} to a new .md note in the feature folder, choose a unique request id, review the approved paths (a folder entry ends with /), and finish its content. Set intent: submit when it is ready. Drafts never run; duplicate IDs block both notes. For CLI intake, keep ${draft} outside the feature folder with intent: draft, then run feature create, feature validate and feature submit (--if-match is the revision from feature validate or feature get). Accept the detected checkout with repository accept --discovery-id ID; it is not watched unless you pass --watch true.`,
  };
}
