import { posix } from 'node:path';
import { parse, stringify } from 'yaml';
import { featureTaskDirectory,                              } from './feature-workflow.js';
import { sharedHash } from './shared-feature-notes.js';
                                                                                                       

                          
                   
               
                            
                                             
                
                     
                       
                  
                   
                             
 
function render(note                )         {
  const body = '# Feature request intake\n\n' + (note.status === 'waiting'
    ? 'This ready request is waiting for the worker. It has not been claimed and no model has been called. The worker checks it again automatically; no answer in this Task is needed.\n\n'
    : note.status === 'blocked'
    ? 'The worker has not claimed this request or called a model. Correct the items below, then commit and push the request or repair the worker configuration.\n\n'
    : 'The previously reported intake issue is resolved. Follow the feature request for its current queue and execution state.\n\n')
    + note.feature + '\n\n' + (note.hold ? '## Waiting for the worker\n\n' + note.hold.message + '\n\n' : '') + (note.issues.length ? '## What needs attention\n\n' + note.issues.map(issue => '- ' + issue.replace(/[\r\n]+/g, ' ')).join('\n') + '\n\n' : '')
    + 'This worker-owned Task is an intake diagnostic, not a model question. Editing it does not dispatch work or change permissions. Its findings apply to the request content digest `' + note.sourceDigest + '`. Pull the shared branch for current progress.\n';
  return '---\n' + stringify(note) + '---\n' + body;
}
function owned(content        , owner        , sourcePath        )          {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match) return false;
  try {
    const value = parse(match[1] , { maxAliasCount: 0 })                  ;
    return !!value && value.schemaVersion === 1 && value.type === 'Task' && value.kind === 'intake-diagnostic'
      && value.owner === owner && value.sourcePath === sourcePath && ['blocked', 'waiting', 'resolved'].includes(value.status)
      && typeof value.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(value.sourceDigest) && typeof value.feature === 'string'
      && Array.isArray(value.issues) && value.issues.length <= 64 && value.issues.every(issue => typeof issue === 'string' && issue.length <= 2000)
      && (value.hold === undefined ? Object.keys(value).length === 9 && value.status !== 'waiting'
        : Object.keys(value).length === 10 && value.status === 'waiting' && validHold(value.hold)) && render(value) === content;
  } catch { return false; }
}

function validHold(hold                     )          {
  return !!hold && typeof hold === 'object' && ['paused', 'budget', 'configuration', 'capacity', 'stopping', 'history_capacity'].includes(hold.code)
    && typeof hold.message === 'string' && hold.message.length <= 2000
    && (hold.resumesAt === undefined || (typeof hold.resumesAt === 'string' && Number.isFinite(Date.parse(hold.resumesAt))))
    && Object.keys(hold).every(key => ['code', 'message', 'resumesAt'].includes(key));
}

/** Diagnostics never reserve execution ownership or modify a team's request. */
export async function publishIntakeDiagnostic(options   
                                                                                        
                                                                                   
 )                         {
  const { repository, workflow, file, owner, signal } = options;
  const directory = featureTaskDirectory(workflow.configuration);
  const path = directory + '/intake-' + sharedHash(owner + '\n' + file.path).slice(0, 24) + '.md';
  const head = await repository.head(signal);
  const existing = await repository.readBlob(head, path, signal);
  if (!existing && !options.issues.length && !options.hold) return null;
  if (existing && !owned(existing, owner, file.path)) throw Error('An intake Task was edited. Preserve the team changes and restore its worker-generated content before synchronization.');
  const note                 = {
    schemaVersion: 1, type: 'Task', kind: 'intake-diagnostic', status: options.hold ? 'waiting' : options.issues.length ? 'blocked' : 'resolved',
    owner, sourcePath: file.path, sourceDigest: file.revision,
    feature: '[[' + posix.relative(directory, file.path).replace(/\.md$/, '') + ']]',
    issues: options.issues.slice(0, 64).map(issue => issue.slice(0, 500)),
    ...(options.hold ? { hold: options.hold } : {}),
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
