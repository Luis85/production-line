import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { inputError } from '../config.mjs';

const runFile = promisify(execFile), reviewFolder = 'feature-reviews', reviewEntry = '/feature-reviews/';
const gitOutput = (project, args) => runFile('git', ['-c', 'core.quotePath=false', ...args], { cwd: project, timeout: 30000, maxBuffer: 1048576, windowsHide: true, encoding: 'utf8' }).then(result => result.stdout);
/**
 * Keeps the default review folder out of an operator-only checkout without changing the committed policy default.
 * Only a project at the root of a Git checkout is touched (the entry is anchored there); anything else is skipped silently.
 * `excluded` is empty when skipped; a skip caused by tracked review files adds a warning.
 * @returns {Promise<{ excluded: string[], warnings: string[] }>}
 */
export async function excludeReviewFolder(project) {
  const lines = await gitOutput(project, ['rev-parse', '--show-prefix', '--git-path', 'info/exclude']).then(output => output.split(/\r?\n/), () => undefined);
  if (!lines || lines[0] !== '' || !lines[1]) return { excluded: [], warnings: [] };
  const path = resolve(project, lines[1]);
  if ((await gitOutput(project, ['ls-files', '--', reviewFolder])).trim()) return { excluded: [], warnings: [`${reviewFolder}/ has tracked files, so ${reviewEntry} was not added to ${lines[1]}. Exclude it yourself if review notes should stay local.`] };
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw inputError('The Git local exclude file must be a regular file, not a link or folder: ' + path);
  const previous = info ? await readFile(path, 'utf8') : '';
  if (!previous.split(/\r?\n/).map(line => line.trimEnd()).includes(reviewEntry)) {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, 'a', 0o600); try { await file.writeFile((previous && !previous.endsWith('\n') ? '\n' : '') + reviewEntry + '\n'); } finally { await file.close(); }
  }
  return { excluded: [reviewEntry], warnings: [] };
}

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
/** `relative` is the project-relative POSIX path used in the copy-paste commands; `excluded` and `warnings` come from excludeReviewFolder. */
export function localIntakeResult(template, relative, { excluded, warnings }) {
  const cli = 'node bin/apps/worker/cli.mjs', request = 'request.md', draft = 'request-draft.md';
  return {
    mode: 'local', connectionRequired: false, template, excluded, warnings,
    source: 'Requests are Markdown files in the feature folder; shared Git intake is intentionally off and repository watching defaults to off.',
    commands: { copy: `Copy ${relative} to ${draft} outside the feature folder, choose a unique id, review paths, and edit the title and body.`, create: `${cli} feature create --name ${request} --markdown ${draft}`, validate: `${cli} feature validate --name ${request}`, submit: `${cli} feature submit --name ${request} --if-match REVISION` },
    next: `Start the worker. Copy ${relative} to a new .md note in the feature folder, choose a unique request id, review the approved paths (a folder entry ends with /), and finish its content. Set intent: submit when it is ready. Drafts never run; duplicate IDs block both notes. For CLI intake, keep ${draft} outside the feature folder with intent: draft, then run feature create, feature validate and feature submit (--if-match is the revision from feature validate or feature get). Accept the detected checkout with repository accept --discovery-id ID; it is not watched unless you pass --watch true.` + (excluded.length ? ` Added ${excluded.join(', ')} to the Git local exclude file (.git/info/exclude) so local review notes stay untracked.` : '') + warnings.map(warning => ' ' + warning).join(''),
  };
}
