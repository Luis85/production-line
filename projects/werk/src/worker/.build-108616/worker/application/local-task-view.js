import { interactionFeatureRequest } from './feature-request-reference.js';
import { createHash } from 'node:crypto';
import { developmentScopeView } from './development.js';
                                                  
                                                         
                                                       
                                                                                                    

/** Adding private task state never implicitly changes either public response. */
function publicFields(task           )                {
  return {
    id: task.id,
    feature: task.feature ?? interactionFeatureRequest(task.id),
    title: task.title,
    sessionId: task.sessionId,
    provider: task.provider,
    model: task.model,
    repository: task.repository,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    error: task.error,
    summary: task.summary,
    archived: task.archived,
    ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
    ...(task.changedFileCount === undefined ? {} : { changedFileCount: task.changedFileCount }),
    ...(task.runId === undefined ? {} : { runId: task.runId }),
    ...(task.currentTurnId === undefined ? {} : { currentTurnId: task.currentTurnId }),
    ...(task.submissionHash === undefined ? {} : { submissionHash: task.submissionHash }),
    ...(task.submissionContextHash === undefined ? {} : { submissionContextHash: task.submissionContextHash }),
    ...(task.gatePolicy === undefined ? {} : { gatePolicy: task.gatePolicy }),
    ...(task.criteria === undefined ? {} : { criteria: task.criteria }),
    ...(task.definition === undefined ? {} : { definition: task.definition }),
    ...(task.repositoryId === undefined ? {} : { repositoryId: task.repositoryId }),
    ...(task.worktree === undefined ? {} : { worktree: task.worktree }),
    ...(task.worktreeKey === undefined ? {} : { worktreeKey: task.worktreeKey }),
    ...(task.admissionFailure === undefined ? {} : { admissionFailure: { paths: [...task.admissionFailure.paths] } }),
    ...(task.worktreeIdentity === undefined ? {} : { worktreeIdentity: { dev: task.worktreeIdentity.dev, ino: task.worktreeIdentity.ino, birthtimeMs: task.worktreeIdentity.birthtimeMs } }),
    ...(task.baseCommit === undefined ? {} : { baseCommit: task.baseCommit }),
    ...(task.implementation === undefined ? {} : { implementation: developmentScopeView(task.implementation) }),
    ...(task.developmentEvidence === undefined ? {} : { developmentEvidence: {
      schemaVersion: task.developmentEvidence.schemaVersion,
      candidateDigest: task.developmentEvidence.candidateDigest,
      changedPaths: [...task.developmentEvidence.changedPaths],
      updatedAt: task.developmentEvidence.updatedAt,
      checks: task.developmentEvidence.checks.map(check => ({
        presetId: check.presetId,
        presetFingerprint: check.presetFingerprint,
        candidateDigest: check.candidateDigest,
        status: check.status,
        exitCode: check.exitCode,
        stdout: check.stdout,
        stderr: check.stderr,
        startedAt: check.startedAt,
        finishedAt: check.finishedAt,
        ...(check.truncated === undefined ? {} : { truncated: check.truncated }),
      })),
    } }),
  };
}

export function projectLocalTaskSummary(task           , interaction                 , request                                            )                       {
  return structuredClone({
    ...publicFields(task),
    files: task.files.map(file => ({ path: file.path, sha256: createHash('sha256').update(file.content).digest('hex') })),
    hasPatch: !!task.patch,
    interaction,
    ...(request ? { requestPhase: request.phase, requestRevision: request.revision } : {}),
  });
}

export function projectLocalTaskDetail(task           , interaction                 )                      {
  return structuredClone({
    ...publicFields(task),
    instruction: task.instruction,
    files: task.files.map(file => ({ path: file.path, content: file.content, existed: file.existed })),
    patch: task.patch,
    interaction,
  });
}
