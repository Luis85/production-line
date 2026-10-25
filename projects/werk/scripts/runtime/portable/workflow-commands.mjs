/** Portable commands use the same authenticated application API as the worker webview. */
export function workflowCommands(catalog, action) {
  catalog['projects list'] = { method: 'GET', path: '/api/managed-projects', mutating: false,
    description: 'Inspect managed project clones/adoptions, committed templates, intake approval and prerequisites.' };
  for (const name of ['register', 'adopt', 'reconcile', 'retry']) catalog['projects ' + name] = {
    ...action('/api/managed-projects', name, [], true), timeoutMs: 180000, mutating: true,
    input: name === 'register' ? 'JSON {operationId,id,name?,repository,branch?,featuresDirectory?}; repository is a credential-free Git URL.'
      : name === 'adopt' ? 'JSON {operationId,id,name?,path,branch?,featuresDirectory?}; path is an explicitly selected existing checkout.'
      : 'JSON {operationId,id}; reconcile only inspects saved work, retry explicitly starts a new clone attempt.',
    description: 'Manage a registered project using a stable operationId. Policy approval is required before its intake is enabled.',
  };
  catalog['feature templates'] = { ...action('/api/features', 'templates', [], false, ['project-id'], { 'project-id': 'projectId' }), mutating: false,
    description: 'List committed project templates and the default selection.' };
  catalog['request release'] = { ...action('/api/requests', 'release', ['id']), mutating: false,
    description: 'Inspect merge, merged-commit build, checksummed artifacts and confirmed GitHub release state.' };
  for (const [name, operation] of Object.entries({
    push: 'push_candidate', 'create-pr': 'create_pull_request', 'reconcile-publication': 'reconcile_publication',
    merge: 'merge_candidate', 'build-release': 'build_release', 'publish-release': 'publish_release',
    'reconcile-release': 'reconcile_release', 'confirm-release-stopped': 'confirm_release_stopped',
    'request-changes': 'request_changes',
  })) catalog['request ' + name] = {
    ...action('/api/requests', operation, ['id', 'if-match', 'key'], true), mutating: true,
    timeoutMs: operation === 'build_release' ? 3780000 : 180000,
    input: 'JSON deliveryRunId, inputRevision, candidateCommit, candidateDigest; publish-release adds releaseTag, reconcile-release/confirm-release-stopped add releaseOperationId, reconcile-publication adds publicationOperationId, request-changes/confirm-release-stopped add note.',
    description: 'Run the guarded operation against the exact retained candidate. Reuse --key for an uncertain-response replay; reconcile unknown outcomes before a new mutation.',
  };
}
