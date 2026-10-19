/** Deliberately bounded release signal, not a whole-system mutation score. */
export const scope = {
  id: 'worker-ready-review-v3',
  targets: [
    'src/shared/serialized-operations.ts',
    'src/shared/request-gate.ts',
    'src/shared/http/response-body.ts',
    'src/shared/webview/bounded-polling.ts',
    'src/worker/application/consumption.ts',
    'src/worker/infrastructure/journal/consumption.ts',
    'src/worker/infrastructure/responses.ts',
    'src/worker/application/ready-review-protocol.ts',
    'src/worker/application/shared-ready-review.ts',
    'src/worker/infrastructure/features/review-eligibility.ts',
  ],
  testFiles: ['scripts/mutation/suites/*.test.mjs', '.mutation-build/tests/*.test.mjs'],
  reusedTests: ['tests/shared/serialized-operations.test.mjs', 'tests/worker/consumption.test.mjs', 'tests/worker/shared-ready-review.test.mjs'],
  reusedFixtures: ['tests/worker/shared-feature-fixture.mjs'],
  supportFiles: ['tests/helpers/typed-boundaries.mjs'],
  timeoutMs: 8 * 60 * 1000,
};
