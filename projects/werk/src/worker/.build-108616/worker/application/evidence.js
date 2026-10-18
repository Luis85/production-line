                                                               
                                                          

const identityFields = ['pairId', 'workerId', 'project', 'taskId', 'attempt', 'profileId', 'provider', 'mode']         ;
const provenanceFields = ['iterationId', 'featureId', 'sourceCommit', 'contextManifestHash', 'configurationHash', 'systemPromptHash', 'policyVersion']         ;

/** Phase timing and measurements may differ; immutable attempt identity and provenance may not. */
export function assertSameEvidence(actual          , expected          )       {
  if (identityFields.some(key => actual[key] !== expected[key]) ||
      provenanceFields.some(key => actual.provenance[key] !== expected.provenance[key]))
    throw Error('Snapshot evidence does not match the persisted attempt');
}

/** A lease-named file alone is insufficient authority to replay terminal evidence. */
export function assertAssignmentEvidence(snapshot          , task      , workerId        , profile         )       {
  if (snapshot.pairId !== task.lease || snapshot.taskId !== task.id || snapshot.project !== task.project ||
      snapshot.attempt !== task.attempt || snapshot.workerId !== workerId || snapshot.profileId !== profile.id ||
      snapshot.provider !== profile.provider || snapshot.mode !== profile.mode ||
      snapshot.provenance.contextManifestHash !== (task.context?.sha256 ?? null) ||
      snapshot.provenance.featureId !== (task.context?.featureId ?? task.source?.featureId ?? null) ||
      snapshot.provenance.sourceCommit !== (task.context?.commit ?? task.source?.commit ?? null) ||
      snapshot.provenance.iterationId !== (task.source?.iterationId ?? null))
    throw Error('Persisted evidence does not match the assigned attempt or context pin');
}
