/** Deliberately bounded release signal, not a whole-system mutation score. */
export const scope = {
  id: 'worker-accounting-protocol-v2',
  targets: [
    'src/shared/serialized-operations.ts',
    'src/shared/request-gate.ts',
    'src/shared/http/response-body.ts',
    'src/shared/webview/bounded-polling.ts',
    'src/worker/application/consumption.ts',
    'src/worker/infrastructure/journal/consumption.ts',
    'src/worker/infrastructure/responses.ts',
  ],
  testFiles: ['scripts/mutation/suites/*.test.mjs', '.mutation-build/tests/*.test.mjs'],
  reusedTests: ['tests/shared/serialized-operations.test.mjs', 'tests/worker/consumption.test.mjs'],
  supportFiles: ['tests/helpers/typed-boundaries.mjs'],
  timeoutMs: 8 * 60 * 1000,
};
