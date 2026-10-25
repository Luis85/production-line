/** Deliberately bounded release signal, not a whole-system mutation score. */
export const authorityScope = {
  id: 'worker-delivery-authority-v5',
  targets: [
    'src/shared/serialized-operations.ts',
    'src/shared/request-gate.ts',
    'src/shared/http/response-body.ts',
    'src/shared/webview/bounded-polling.ts',
    'src/worker/application/consumption.ts',
    'src/worker/application/delivery-policy.ts',
    'src/worker/application/delivery-policy-approval.ts',
    'src/worker/application/delivery-criterion-decisions.ts',
    'src/worker/application/delivery-verification-eligibility.ts',
    'src/worker/application/delivery-coordination.ts',
    'src/worker/application/serial-executor.ts',
    'src/worker/application/execution-recovery.ts',
    'src/worker/application/delivery-dependency-plan.ts',
    'src/worker/application/delivery-execution-policy.ts',
    'src/worker/application/delivery-execution-snapshot.ts',
    'src/worker/application/delivery-execution-routing.ts',
    'src/worker/application/delivery-behavior-policy.ts',
    'src/worker/application/delivery-check-packs.ts',
    'src/worker/application/delivery-retention.ts',
    'src/worker/infrastructure/journal/consumption.ts',
    'src/worker/infrastructure/responses.ts',
    'src/worker/application/ready-review-protocol.ts',
    'src/worker/application/shared-ready-review.ts',
    'src/worker/infrastructure/features/review-eligibility.ts',
  ],
  testFiles: ['scripts/mutation/suites/*.test.mjs', '.mutation-build/tests/*.test.mjs'],
  reusedTests: ['tests/shared/serialized-operations.test.mjs', 'tests/worker/consumption.test.mjs', 'tests/worker/shared-ready-review.test.mjs',
    'tests/worker/shared-ready-review-publication.test.mjs', 'tests/worker/shared-ready-review-selection.test.mjs',
    'tests/worker/shared-ready-review-recovery.test.mjs',
    'tests/worker/delivery-criterion-decisions.test.mjs', 'tests/worker/delivery-coordination.test.mjs',
    'tests/worker/delivery-execution-policy.test.mjs', 'tests/worker/delivery-policy-extensions.test.mjs',
    'tests/worker/delivery-policy-routing.test.mjs',
    'tests/worker/delivery-check-packs.test.mjs'],
  reusedFixtures: ['tests/worker/shared-feature-fixture.mjs', 'tests/worker/shared-ready-review-fixture.mjs'],
  supportFiles: ['tests/helpers/typed-boundaries.mjs', 'scripts/mutation/suites/workflow-fixture.mjs', 'scripts/mutation/suites/workflow-local-fixture.mjs'],
  timeoutMs: 12 * 60 * 1000,
};


/** Workflow authority is measured independently so its denominator and budget stay explicit. */
export const workflowScope = {
  id: 'worker-workflow-v2',
  reportDirectory: 'reports/mutation/workflow',
  targets: [
    'src/worker/application/delivery-acceptance.ts',
    'src/worker/application/delivery-policy.ts',
    'src/worker/application/delivery-completion.ts',
    'src/worker/application/local-merge-contracts.ts',
    'src/worker/application/local-merge-view.ts',
    'src/worker/application/local-merge-runtime.ts',
    'src/worker/application/local-merge-baseline.ts',
    'src/worker/infrastructure/journal/requests/local-merge.ts',
    'src/worker/application/release-runtime.ts',
    'src/worker/application/release-view.ts',
    'src/worker/application/remote-delivery-runtime.ts',
    'src/worker/application/remote-delivery-history.ts',
    'src/worker/application/remote-delivery-rework.ts',
    'src/worker/application/shared-review-rework.ts',
    'src/worker/application/shared-feature-policy.ts',
    'src/worker/application/shared-local-merge-projection.ts',
    'src/worker/application/shared-release-projection.ts',
    'src/worker/infrastructure/journal/requests/publication.ts',
    'src/worker/infrastructure/journal/requests/release.ts',
  ],
  suitePrefix: 'workflow-',
  testFiles: ['scripts/mutation/suites/workflow-*.test.mjs', 'scripts/mutation/suites/delivery-policy.test.mjs', '.mutation-build/tests/*.test.mjs'],
  reusedTests: ['tests/worker/remote-delivery-runtime.test.mjs', 'tests/worker/remote-delivery-journal.test.mjs',
    'tests/worker/release-runtime.test.mjs', 'tests/worker/release-journal.test.mjs', 'tests/worker/local-merge-journal.test.mjs', 'tests/worker/local-merge-status.test.mjs'],
  reusedFixtures: ['tests/worker/remote-delivery-fixtures.mjs', 'tests/worker/release-fixtures.mjs',
    'tests/worker/request-gate-fixtures.mjs', 'tests/worker/fixture-cleanup.mjs'],
  supportFiles: ['scripts/mutation/suites/workflow-fixture.mjs', 'scripts/mutation/suites/workflow-local-fixture.mjs', 'scripts/mutation/suites/delivery-policy.test.mjs', 'tests/helpers/typed-boundaries.mjs'],
  timeoutMs: 12 * 60 * 1000,
};
const mutationScopes = { authority: authorityScope, workflow: workflowScope };
export const mutationTargets = [...new Set(Object.values(mutationScopes).flatMap(value => value.targets))];
export function selectMutationScope(name = 'authority') {
  if (!Object.hasOwn(mutationScopes, name)) throw Error('Mutation scope must be authority or workflow.');
  return mutationScopes[name];
}
export function mutationOptions(args) {
  let name = 'authority', advisory = false, selected = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--advisory' && !advisory) advisory = true;
    else if (arg === '--scope' && !selected && args[index + 1]) { name = args[++index]; selected = true; }
    else throw Error('Usage: npm run mutation -- [--advisory] [--scope authority|workflow]');
  }
  selectMutationScope(name);
  return { name, advisory };
}
// Stryker and its isolated compiler inherit this selection from the owning runner.
export const scope = selectMutationScope(process.env.WERK_MUTATION_SCOPE);
