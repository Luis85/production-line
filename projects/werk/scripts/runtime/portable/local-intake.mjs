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
  return `---
schemaVersion: 1
title: Describe the request
status: draft
mode: patch
provider: ${provider}
# Local request for an operator-only worker; never add templateId (that marks shared Git intake).
# Copy this file OUTSIDE the feature folder, edit it, then run feature create --markdown <copy>,
# feature validate and feature submit. Inside the folder an unedited copy is scanned as a
# request (an error until paths is set) and stays a second request after feature create.
# mode: patch needs paths: uncomment it and list the approved project-relative files;
# only these are supplied to the model. A folder entry ends with / and supplies its files.
# paths:
#   - src/example.ts
#   - docs/
# Optional instruction profile: definitionRef (stable) or definitionId (worker-local).
# definitionRef: my-profile
---
# Goal

Describe the problem and the desired result.

## Acceptance criteria

- [ ] Describe an observable result.

## Context

Add constraints and relevant project details. Chat does not read project files.
Only the files listed in paths are supplied to the model.
`;
}
/** `relative` is the project-relative POSIX path used in the copy-paste commands. */
export function localIntakeResult(template, relative) {
  const cli = 'node bin/apps/worker/cli.mjs', request = 'request.md', draft = 'request-draft.md';
  return {
    mode: 'local', connectionRequired: false, template,
    source: 'Requests are Markdown files in the feature folder; shared Git intake is intentionally off and repository watching defaults to off.',
    commands: { copy: `Copy ${relative} to ${draft} outside the feature folder, uncomment and set paths, and edit the title and body.`, create: `${cli} feature create --name ${request} --markdown ${draft}`, validate: `${cli} feature validate --name ${request}`, submit: `${cli} feature submit --name ${request} --if-match REVISION` },
    next: `Start the worker. Copy ${relative} to ${draft} outside the feature folder and edit it: mode patch needs paths (a folder entry ends with /). Keep the copy outside the feature folder: the folder is scanned, so an unedited copy there is an error and stays a second request after feature create. Then run feature create, feature validate and feature submit (--if-match is the revision from feature validate or feature get). Accept the detected checkout with repository accept --discovery-id ID; it is not watched unless you pass --watch true.`,
  };
}
