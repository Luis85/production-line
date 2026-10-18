import { join } from 'node:path';
import { atomicWrite, readBoundedFile } from '../journal/files.js';
import { featureId } from './document.js';
                                                                                                                            

/** Index pointers must stay inside this feature's generated execution directory. */
export function validateFeatureExecution(record               ) {
  if (record.executionDirectory !== undefined && record.executionDirectory !== `_results/${record.id}/`) throw Error('Invalid feature execution directory.');
  const links = record.execution;
  if (!links) return;
  if (!featureId.test(links.runId) || !Number.isInteger(links.attempt) || links.attempt < 1) throw Error('Invalid feature execution identity.');
  const prefix = `_results/${record.id}/${links.runId}`;
  if (links.before !== prefix + '.before.json' || (links.after !== undefined && links.after !== prefix + '.after.json') || (links.result !== undefined && links.result !== prefix + '.md') || (links.patch !== undefined && links.patch !== prefix + '.patch')) throw Error('Invalid feature execution artifact path.');
  if (links.completedAt !== undefined && !Number.isFinite(Date.parse(links.completedAt))) throw Error('Invalid feature execution completion time.');
}

/** Replay verifies original exports rather than rewriting evidence from an older run. */
export async function writeImmutableFeatureArtifact(path        , value        ) {
  const previous = await readBoundedFile(path, 524288).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (previous !== undefined) {
    if (previous !== value) throw Error('Exported execution evidence changed. Preserve the existing artifact and inspect worker state.');
    return;
  }
  await atomicWrite(path, value);
}

export async function exportFeatureEvidence(directory        , record               , evidence                          , checkDirectory                                 )                                 {
  if (!featureId.test(record.id) || !featureId.test(evidence.runId) || !Number.isInteger(evidence.attempt) || evidence.attempt < 1) throw Error('Invalid feature execution identity.');
  const executionDirectory = join(directory, '_results', record.id);
  await checkDirectory(executionDirectory);
  const links                        = { runId: evidence.runId, attempt: evidence.attempt, before: `_results/${record.id}/${evidence.runId}.before.json` };
  const snapshot = (phase                    ) => JSON.stringify({
    schemaVersion: 1, featureId: record.id, taskId: record.taskId, sessionId: record.sessionId,
    runId: evidence.runId, attempt: evidence.attempt, phase,
    snapshot: phase === 'before' ? evidence.before : evidence.after,
    usage: phase === 'after' ? evidence.usage ?? null : null,
    durationMs: phase === 'after' ? evidence.durationMs ?? null : null,
    queueDurationMs: phase === 'after' ? evidence.queueDurationMs ?? null : null,
  }, null, 2) + '\n';
  await writeImmutableFeatureArtifact(join(directory, links.before), snapshot('before'));
  if (evidence.after) {
    links.after = `_results/${record.id}/${evidence.runId}.after.json`;
    links.completedAt = evidence.after.capturedAt;
    await writeImmutableFeatureArtifact(join(directory, links.after), snapshot('after'));
  }
  return links;
}
