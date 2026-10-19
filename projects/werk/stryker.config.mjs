import { scope } from './scripts/mutation/scope.mjs';

export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  mutate: scope.targets,
  ignorePatterns: ['**', '!src/shared/**/*.ts', '!src/worker/**/*.ts', '!scripts/mutation/**/*.mjs', ...[...scope.reusedTests, ...scope.reusedFixtures, ...scope.supportFiles].map(path => `!${path}`), '!package.json', '!stryker.config.mjs', '**/node_modules/**', '**/dist/**', 'src/worker/webview/**'],
  testRunner: 'tap',
  plugins: ['@stryker-mutator/tap-runner'],
  tap: { testFiles: scope.testFiles, nodeArgs: ['--test-reporter=tap'], forceBail: true },
  buildCommand: 'node scripts/mutation/build.mjs',
  coverageAnalysis: 'perTest',
  concurrency: 2,
  timeoutMS: 2000,
  timeoutFactor: 2,
  dryRunTimeoutMinutes: 1,
  thresholds: { high: 85, low: 70, break: 0 },
  reporters: ['clear-text', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  cleanTempDir: true,
};
