import { posix } from 'node:path';
import { parse, stringify } from 'yaml';
import { featureTaskDirectory, type FeatureWorkflowSnapshot } from './feature-workflow.js';
import { sharedHash } from './shared-feature-notes.js';
import type { SharedBlob, SharedRepositoryPort } from './shared-feature-state.js';

interface DiagnosticNote {
  schemaVersion: 1;
  type: 'Task';
  kind: 'intake-diagnostic';
  status: 'blocked' | 'resolved';
  owner: string;
  sourcePath: string;
  sourceDigest: string;
  feature: string;
  issues: string[];
}
function render(note: DiagnosticNote): string {
  const body = '# Feature request intake\n\n' + (note.status === 'blocked'
    ? 'The worker has not claimed this request or called a model. Correct the items below, then commit and push the request or repair the worker configuration.\n\n'
    : 'The previously reported intake issue is resolved. Follow the feature request for its current queue and execution state.\n\n')
    + note.feature + '\n\n' + (note.issues.length ? '## What needs attention\n\n' + note.issues.map(issue => '- ' + issue.replace(/[\r\n]+/g, ' ')).join('\n') + '\n\n' : '')
    + 'This worker-owned Task is an intake diagnostic, not a model question. Editing it does not dispatch work or change permissions. Its findings apply to the request content digest `' + note.sourceDigest + '`. Pull the shared branch for current progress.\n';
  return '---\n' + stringify(note) + '---\n' + body;
}
function owned(content: string, owner: string, sourcePath: string): boolean {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match) return false;
  try {
    const value = parse(match[1]!, { maxAliasCount: 0 }) as DiagnosticNote;
    return !!value && value.schemaVersion === 1 && value.type === 'Task' && value.kind === 'intake-diagnostic'
      && value.owner === owner && value.sourcePath === sourcePath && ['blocked', 'resolved'].includes(value.status)
      && typeof value.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(value.sourceDigest) && typeof value.feature === 'string'
      && Array.isArray(value.issues) && value.issues.length <= 64 && value.issues.every(issue => typeof issue === 'string' && issue.length <= 2000)
      && Object.keys(value).length === 9 && render(value) === content;
  } catch { return false; }
}

/** Diagnostics never reserve execution ownership or modify a team's request. */
export async function publishIntakeDiagnostic(options: {
  repository: SharedRepositoryPort; workflow: FeatureWorkflowSnapshot; file: SharedBlob;
  owner: string; issues: string[]; signal: AbortSignal;
}): Promise<string | null> {
  const { repository, workflow, file, owner, signal } = options;
  const directory = featureTaskDirectory(workflow.configuration);
  const path = directory + '/intake-' + sharedHash(owner + '\n' + file.path).slice(0, 24) + '.md';
  const head = await repository.head(signal);
  const existing = await repository.readBlob(head, path, signal);
  if (!existing && !options.issues.length) return null;
  if (existing && !owned(existing, owner, file.path)) throw Error('An intake Task was edited. Preserve the team changes and restore its worker-generated content before synchronization.');
  const note: DiagnosticNote = {
    schemaVersion: 1, type: 'Task', kind: 'intake-diagnostic', status: options.issues.length ? 'blocked' : 'resolved',
    owner, sourcePath: file.path, sourceDigest: file.revision,
    feature: '[[' + posix.relative(directory, file.path).replace(/\.md$/, '') + ']]',
    issues: options.issues.slice(0, 64).map(issue => issue.slice(0, 500)),
  };
  const content = render(note);
  if (content === existing) return path;
  await repository.publishLifecycle({
    operationId: 'intake-' + sharedHash(owner + file.path + file.revision + content + (existing ?? '')),
    request: { path: file.path, expectedRevision: file.revision, content: file.content },
    artifacts: [{ path, expectedRevision: existing === null ? null : sharedHash(existing), content }],
  }, signal);
  return path;
}
